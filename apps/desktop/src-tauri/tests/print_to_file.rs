//! Runs the PDFKit print operation File ▸ Print… shows on macOS
//! (`print::prepare`), without its dialog: the job is saved to a PDF file
//! instead of going to a printer, and that file is read back. The dialog
//! itself (a sheet on Folio's window) cannot run unattended.

#[cfg(target_os = "macos")]
fn main() {
    macos::prints_every_page_on_the_paper();
    macos::refuses_what_it_cannot_read();
    println!("print_to_file: ok");
}

#[cfg(not(target_os = "macos"))]
fn main() {}

#[cfg(target_os = "macos")]
mod macos {
    use folio_desktop_lib::print::{prepare, PrintError};
    use objc2::runtime::AnyObject;
    use objc2::{AnyThread, MainThreadMarker};
    use objc2_app_kit::{NSPrintJobSavingURL, NSPrintSaveJob};
    use objc2_foundation::{NSData, NSURL};
    use objc2_pdf_kit::{PDFDisplayBox, PDFDocument};
    use std::path::PathBuf;

    fn fixture(name: &str) -> Vec<u8> {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../tests/fixtures")
            .join(name);
        std::fs::read(path).expect("the fixture exists")
    }

    fn main_thread() -> MainThreadMarker {
        MainThreadMarker::new().expect("runs on the main thread")
    }

    /// Pages of both orientations (the fixture's pages are stored with each
    /// rotation) all come out in order on sheets of the paper's size, with
    /// their text, rather than as images on sheets of the window's shape.
    pub fn prints_every_page_on_the_paper() {
        let mtm = main_thread();
        let prepared =
            prepare(fixture("rotated-pages.pdf"), "Rotated.pdf", mtm).expect("PDFKit reads it");
        let operation = &prepared.operation;
        assert_eq!(operation.jobTitle().unwrap().to_string(), "Rotated.pdf");
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("printed.pdf");
        let info = operation.printInfo();
        info.setJobDisposition(unsafe { NSPrintSaveJob });
        let url = NSURL::from_file_path(&target).unwrap();
        let url: &AnyObject = &url;
        // SAFETY: the job saving URL is an NSURL.
        unsafe { info.dictionary().insert(NSPrintJobSavingURL, url) };
        operation.setShowsPrintPanel(false);
        operation.setShowsProgressPanel(false);
        assert!(operation.runOperation());

        let paper = info.paperSize();
        let printed = NSData::with_bytes(&std::fs::read(&target).expect("the job was saved"));
        // SAFETY: plain PDFKit calls on this thread's objects.
        unsafe {
            let document = PDFDocument::initWithData(PDFDocument::alloc(), &printed).unwrap();
            assert_eq!(document.pageCount(), 4);
            for index in 0..document.pageCount() {
                let page = document.pageAtIndex(index).unwrap();
                let bounds = page.boundsForBox(PDFDisplayBox::MediaBox);
                assert_eq!(page.rotation(), 0, "page {index}");
                // Printed as text, not as an image of the page.
                let text = page.string().map(|text| text.to_string());
                let expected = format!("Stored rotation {}", index * 90);
                assert!(
                    text.as_deref().is_some_and(|text| text.contains(&expected)),
                    "page {index}: {text:?}"
                );
                assert!(
                    (bounds.size.width - paper.width).abs() < 1.0
                        && (bounds.size.height - paper.height).abs() < 1.0,
                    "page {index}: {bounds:?} on {paper:?}"
                );
            }
        }
    }

    pub fn refuses_what_it_cannot_read() {
        let mtm = main_thread();
        for name in [
            "not-a-pdf.pdf",
            "encrypted-user-password.pdf",
            "header-only.pdf",
        ] {
            assert_eq!(
                prepare(fixture(name), "Document.pdf", mtm).err(),
                Some(PrintError::Unreadable),
                "{name}"
            );
        }
    }
}
