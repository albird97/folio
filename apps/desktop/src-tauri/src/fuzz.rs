//! Settings and inputs for the property tests (`mod properties` in each
//! module) that fuzz everything Folio reads from the webview, from Chrome and
//! from its own files: whatever comes in must never make Folio panic, never
//! get past the strict validators when they should refuse it, and what
//! Folio writes must read back the same.
//!
//! Inputs mix arbitrary text and bytes with pieces that matter to Folio's
//! parsers (path separators, Windows device names, invisible and control
//! characters, percent escapes, ids of the shapes Folio makes, JSON), so
//! that the interesting cases come up often, not once in a million.

use proptest::prelude::*;
use proptest::test_runner::Config;
use serde_json::Value;

/// `cases` per property, which keeps the whole suite to a few seconds in CI.
/// `PROPTEST_CASES` replaces it for a longer run, e.g.
/// `PROPTEST_CASES=20000 cargo test properties`. Failures are not written to
/// files in the source tree: each one found becomes an ordinary unit test.
pub fn config(cases: u32) -> Config {
    let default = Config {
        failure_persistence: None,
        ..Config::default()
    };
    if std::env::var_os("PROPTEST_CASES").is_some() {
        default
    } else {
        Config { cases, ..default }
    }
}

/// `CON`, `nul.txt`, `Com1`, `LPT¹ .pdf`… in any case.
pub fn device_name() -> impl Strategy<Value = String> {
    let device = prop::sample::select(vec![
        "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$", "COM0", "COM1", "COM9", "COM¹", "COM³",
        "LPT0", "LPT5", "LPT²",
    ]);
    let ending = prop::sample::select(vec!["", ".pdf", ".txt", ".tar.gz", " ", " .pdf", "."]);
    (device, ending, prop::collection::vec(any::<bool>(), 7)).prop_map(|(device, ending, upper)| {
        let device: String = device
            .chars()
            .zip(upper)
            .map(|(c, upper)| {
                if upper {
                    c.to_ascii_uppercase()
                } else {
                    c.to_ascii_lowercase()
                }
            })
            .collect();
        format!("{device}{ending}")
    })
}

/// A piece of text that matters to some parser.
fn fragment() -> BoxedStrategy<String> {
    let special = prop::sample::select(vec![
        // Paths.
        "/",
        "\\",
        ".",
        "..",
        ":",
        " ",
        "~",
        "\\\\?\\",
        "C:\\",
        "incoming",
        "document.pdf",
        // Names and extensions.
        ".pdf",
        ".PDF",
        ".exe",
        ".folio-",
        ".tmp",
        ".bak",
        "chrome-extension://",
        // Invisible, reordering and control characters, and fillers.
        "\0",
        "\t",
        "\n",
        "\r\n",
        "\u{7f}",
        "\u{85}",
        "\u{AD}",
        "\u{200B}",
        "\u{200D}",
        "\u{202E}",
        "\u{2066}",
        "\u{2028}",
        "\u{FEFF}",
        "\u{3164}",
        "\u{2800}",
        "\u{E0041}",
        "\u{0301}",
        "\u{3000}",
        // Escapes and JSON.
        "%",
        "%2F",
        "%5C",
        "%00",
        "%E2%80%AE",
        "%C3",
        "%%",
        "{",
        "}",
        "[",
        "]",
        "\"",
        ",",
        "\\u0000",
        // Other scripts and emoji.
        "é",
        "日本",
        "👨\u{200D}👩",
        "📄",
    ]);
    prop_oneof![
        4 => special.prop_map(str::to_owned),
        2 => device_name(),
        2 => "[A-Za-z0-9_-]{1,12}",
        1 => "[0-9a-f]{32}",
        1 => any::<u128>().prop_map(|bits| uuid::Uuid::from_u128(bits).hyphenated().to_string()),
        1 => "[ -~]{1,8}",
        1 => any::<char>().prop_map(String::from),
        1 => (1usize..300).prop_map(|length| "a".repeat(length)),
    ]
    .boxed()
}

/// Arbitrary text, or a mix of [`fragment`]s.
pub fn text() -> BoxedStrategy<String> {
    prop_oneof![
        any::<String>(),
        prop::collection::vec(fragment(), 0..8).prop_map(|parts| parts.concat()),
    ]
    .boxed()
}

/// Object keys: the names Folio's messages and files use, and others.
fn key() -> BoxedStrategy<String> {
    prop_oneof![
        3 => prop::sample::select(vec![
            "type", "name", "size", "sha256", "transfer", "index", "data", "id", "path",
            "title", "savedAt", "createdAt", "openedAt", "checkAutomatically", "lastCheck",
            "allowed_origins",
        ])
        .prop_map(str::to_owned),
        1 => text(),
    ]
    .boxed()
}

/// JSON values of any shape, with Folio's keys among the arbitrary ones.
pub fn json() -> BoxedStrategy<Value> {
    let leaf = prop_oneof![
        Just(Value::Null),
        any::<bool>().prop_map(Value::from),
        any::<i64>().prop_map(Value::from),
        any::<u64>().prop_map(Value::from),
        any::<f64>().prop_map(Value::from),
        text().prop_map(Value::from),
    ];
    leaf.prop_recursive(4, 32, 6, |inner| {
        prop_oneof![
            prop::collection::vec(inner.clone(), 0..6).prop_map(Value::Array),
            prop::collection::vec((key(), inner), 0..6)
                .prop_map(|entries| Value::Object(entries.into_iter().collect())),
        ]
    })
    .boxed()
}

/// Arbitrary bytes, text, JSON, or JSON that is cut or nested too deep.
pub fn bytes() -> BoxedStrategy<Vec<u8>> {
    prop_oneof![
        prop::collection::vec(any::<u8>(), 0..256),
        text().prop_map(String::into_bytes),
        json().prop_map(|value| serde_json::to_vec(&value).unwrap()),
        (json(), any::<prop::sample::Index>()).prop_map(|(value, cut)| {
            let mut bytes = serde_json::to_vec(&value).unwrap();
            bytes.truncate(cut.index(bytes.len() + 1));
            bytes
        }),
        (1usize..5000).prop_map(|depth| {
            let mut bytes = br#"{"type":"hello","x":"#.to_vec();
            bytes.extend(std::iter::repeat_n(b'[', depth));
            bytes.extend(std::iter::repeat_n(b']', depth));
            bytes.push(b'}');
            bytes
        }),
    ]
    .boxed()
}
