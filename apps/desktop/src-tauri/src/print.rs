//! File ▸ Print… on macOS prints the PDF itself, like Preview: the UI exports
//! the pages to print into an in-memory PDF and `print_pdf` hands it to
//! PDFKit, which scales each page to the paper's printable area and turns it
//! to the paper's orientation. Text stays vector text.
//!
//! WKWebView cannot print Folio's own print layout faithfully: in its print
//! operation, CSS viewport units and `orientation` media queries resolve
//! against the window rather than the paper, so pages came out turned and
//! shrunk. Windows and Linux keep printing that layout (`print_window`).
//!
//! Nothing is written to disk: the data goes from the request body to PDFKit
//! in memory, and the webview never sees a path.

#[cfg(target_os = "macos")]
pub use macos::{prepare, PreparedPrint};

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum PrintError {
    #[error("Printing a PDF directly is not available here.")]
    Unsupported,
    #[error("The document could not be read for printing.")]
    Unreadable,
    #[error("The print dialog could not be opened.")]
    Failed,
}

impl PrintError {
    pub fn code(&self) -> &'static str {
        match self {
            PrintError::Unsupported => "unsupported",
            PrintError::Unreadable => "unreadable-pdf",
            PrintError::Failed => "print-failed",
        }
    }
}

/// Shows the print dialog for `pdf` as a sheet on `window`. Resolves once the
/// user printed or cancelled; the job is called `title` (the print queue
/// shows it).
#[cfg(target_os = "macos")]
pub async fn print_pdf(
    window: &tauri::WebviewWindow,
    pdf: Vec<u8>,
    title: String,
) -> Result<(), PrintError> {
    macos::print(window, pdf, title).await
}

/// Other platforms print the UI's own layout (`print_window`); the UI only
/// asks for this on macOS.
#[cfg(not(target_os = "macos"))]
pub async fn print_pdf(
    _window: &tauri::WebviewWindow,
    _pdf: Vec<u8>,
    _title: String,
) -> Result<(), PrintError> {
    Err(PrintError::Unsupported)
}

#[cfg(target_os = "macos")]
mod macos {
    use super::PrintError;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, NSObject};
    use objc2::{define_class, msg_send, sel, AnyThread, DefinedClass, MainThreadMarker};
    use objc2::{MainThreadOnly, Message};
    use objc2_app_kit::{NSPrintInfo, NSPrintOperation, NSWindow};
    use objc2_foundation::{NSData, NSObjectProtocol, NSString};
    use objc2_pdf_kit::{PDFDocument, PDFPrintScalingMode};
    use std::cell::Cell;
    use std::ffi::c_void;
    use tokio::sync::oneshot;

    type Done = oneshot::Sender<Result<(), PrintError>>;

    /// A print operation for a document, ready to run.
    pub struct PreparedPrint {
        pub operation: Retained<NSPrintOperation>,
        /// Kept until the operation has run.
        pub document: Retained<PDFDocument>,
    }

    /// Reads `pdf` with PDFKit and makes the operation that prints it: each
    /// page scaled to fit the paper's printable area and turned to match the
    /// paper's orientation, as Preview prints by default.
    pub fn prepare(
        pdf: Vec<u8>,
        title: &str,
        mtm: MainThreadMarker,
    ) -> Result<PreparedPrint, PrintError> {
        let data = NSData::from_vec(pdf);
        // SAFETY: `data` is a valid NSData; PDFKit copies what it needs.
        let document = unsafe { PDFDocument::initWithData(PDFDocument::alloc(), &data) }
            .ok_or(PrintError::Unreadable)?;
        // The UI exports the pages unprotected; anything else is not what it
        // sent.
        // SAFETY: plain getters on a document this thread created.
        if unsafe { document.isLocked() || document.pageCount() == 0 } {
            return Err(PrintError::Unreadable);
        }
        // The app's print settings (default printer and paper). PDFKit fits
        // pages to the paper's printable area whatever its margins say.
        let info = NSPrintInfo::sharedPrintInfo();
        // SAFETY: called on the main thread (`mtm`) with valid arguments.
        let operation = unsafe {
            document.printOperationForPrintInfo_scalingMode_autoRotate(
                Some(&info),
                PDFPrintScalingMode::PageScaleToFit,
                true,
                mtm,
            )
        }
        .ok_or(PrintError::Failed)?;
        operation.setJobTitle(Some(&NSString::from_str(title)));
        Ok(PreparedPrint {
            operation,
            document,
        })
    }

    struct Ivars {
        done: Cell<Option<Done>>,
        _document: Retained<PDFDocument>,
    }

    define_class!(
        // SAFETY: NSObject has no subclassing requirements, and
        // `PrintDelegate` does not implement `Drop`.
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "FolioPrintDelegate"]
        #[ivars = Ivars]
        struct PrintDelegate;

        unsafe impl NSObjectProtocol for PrintDelegate {}

        impl PrintDelegate {
            /// The `didRunSelector` of `runOperationModalForWindow:…`: the
            /// dialog closed and the job (if any) was handed to the system.
            #[unsafe(method(printOperationDidRun:success:contextInfo:))]
            fn did_run(&self, _operation: &NSPrintOperation, _success: bool, context: *mut c_void) {
                // Printing and cancelling both end the UI's wait; a failed
                // job is reported by the system's print queue.
                if let Some(done) = self.ivars().done.take() {
                    let _ = done.send(Ok(()));
                }
                // SAFETY: `context` is the reference `run_sheet` handed over
                // with `Retained::into_raw`, and AppKit calls this only once.
                drop(unsafe { Retained::from_raw(context.cast::<PrintDelegate>()) });
            }
        }
    );

    impl PrintDelegate {
        fn new(
            done: Done,
            document: Retained<PDFDocument>,
            mtm: MainThreadMarker,
        ) -> Retained<Self> {
            let this = Self::alloc(mtm).set_ivars(Ivars {
                done: Cell::new(Some(done)),
                _document: document,
            });
            // SAFETY: NSObject's designated initializer.
            unsafe { msg_send![super(this), init] }
        }
    }

    /// Runs the operation as a sheet on `window`; `done` is told when it
    /// closes.
    fn run_sheet(window: &NSWindow, prepared: PreparedPrint, done: Done, mtm: MainThreadMarker) {
        let PreparedPrint {
            operation,
            document,
        } = prepared;
        let delegate = PrintDelegate::new(done, document, mtm);
        // AppKit does not retain the delegate: the reference handed over as
        // context info keeps it alive until its callback releases it.
        let context = Retained::into_raw(delegate.retain()).cast::<c_void>();
        let delegate: &AnyObject = &delegate;
        // SAFETY: the delegate implements the selector with the signature
        // AppKit calls it with, and `context` is what that method expects.
        unsafe {
            operation.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
                window,
                Some(delegate),
                Some(sel!(printOperationDidRun:success:contextInfo:)),
                context,
            );
        }
    }

    pub async fn print(
        window: &tauri::WebviewWindow,
        pdf: Vec<u8>,
        title: String,
    ) -> Result<(), PrintError> {
        let (done, finished) = oneshot::channel();
        let target = window.clone();
        window
            .run_on_main_thread(move || {
                let Some(mtm) = MainThreadMarker::new() else {
                    let _ = done.send(Err(PrintError::Failed));
                    return;
                };
                let ns_window = match target.ns_window() {
                    Ok(pointer) if !pointer.is_null() => pointer.cast::<NSWindow>(),
                    _ => {
                        let _ = done.send(Err(PrintError::Failed));
                        return;
                    }
                };
                match prepare(pdf, &title, mtm) {
                    // SAFETY: Tauri's pointer to the window's NSWindow, which
                    // lives at least as long as this call on the main thread.
                    Ok(prepared) => run_sheet(unsafe { &*ns_window }, prepared, done, mtm),
                    Err(error) => {
                        let _ = done.send(Err(error));
                    }
                }
            })
            .map_err(|_| PrintError::Failed)?;
        finished.await.unwrap_or(Err(PrintError::Failed))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_have_codes_and_say_nothing_about_the_document() {
        for (error, code) in [
            (PrintError::Unsupported, "unsupported"),
            (PrintError::Unreadable, "unreadable-pdf"),
            (PrintError::Failed, "print-failed"),
        ] {
            assert_eq!(error.code(), code);
            assert!(error.to_string().ends_with('.'));
        }
    }
}
