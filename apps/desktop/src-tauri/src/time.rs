//! ISO-8601 timestamps in UTC with millisecond precision, formatted like
//! JavaScript's `Date.prototype.toISOString` so they sort correctly as
//! strings on both sides of the IPC boundary.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

const SECONDS_PER_DAY: u64 = 86_400;

/// Formats `time` as `YYYY-MM-DDTHH:MM:SS.mmmZ`. Times before 1970 are
/// clamped to the epoch (Folio never stores any).
pub fn iso8601(time: SystemTime) -> String {
    let since = time.duration_since(UNIX_EPOCH).unwrap_or_default();
    let seconds = since.as_secs();
    let (year, month, day) = civil_from_days((seconds / SECONDS_PER_DAY) as i64);
    let rest = seconds % SECONDS_PER_DAY;
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60,
        since.subsec_millis()
    )
}

pub fn now() -> String {
    iso8601(SystemTime::now())
}

/// Parses what [`iso8601`] writes (milliseconds optional). Anything else is
/// rejected rather than guessed at.
pub fn parse_iso8601(text: &str) -> Option<SystemTime> {
    let bytes = text.as_bytes();
    let digits = |range: std::ops::Range<usize>| -> Option<u64> {
        let part = bytes.get(range)?;
        if part.is_empty() || !part.iter().all(u8::is_ascii_digit) {
            return None;
        }
        std::str::from_utf8(part).ok()?.parse().ok()
    };
    let separators_ok = bytes.get(4) == Some(&b'-')
        && bytes.get(7) == Some(&b'-')
        && bytes.get(10) == Some(&b'T')
        && bytes.get(13) == Some(&b':')
        && bytes.get(16) == Some(&b':');
    if !separators_ok {
        return None;
    }
    let millis = match bytes.len() {
        20 if bytes[19] == b'Z' => 0,
        24 if bytes[19] == b'.' && bytes[23] == b'Z' => digits(20..23)?,
        _ => return None,
    };
    let (year, month, day) = (digits(0..4)?, digits(5..7)?, digits(8..10)?);
    let (hour, minute, second) = (digits(11..13)?, digits(14..16)?, digits(17..19)?);
    if year < 1970
        || !(1..=12).contains(&month)
        || day < 1
        || day > days_in_month(year, month)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return None;
    }
    let days = days_from_civil(year as i64, month as u32, day as u32);
    let seconds = days as u64 * SECONDS_PER_DAY + hour * 3600 + minute * 60 + second;
    Some(UNIX_EPOCH + Duration::from_secs(seconds) + Duration::from_millis(millis))
}

fn is_leap_year(year: u64) -> bool {
    (year.is_multiple_of(4) && !year.is_multiple_of(100)) || year.is_multiple_of(400)
}

fn days_in_month(year: u64, month: u64) -> u64 {
    match month {
        2 if is_leap_year(year) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// Days since 1970-01-01 to a proleptic Gregorian date (Howard Hinnant's
/// `civil_from_days`).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * shifted_month + 2) / 5 + 1) as u32;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    } as u32;
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// The inverse of [`civil_from_days`].
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year.rem_euclid(400);
    let month = i64::from(month);
    let shifted_month = if month > 2 { month - 3 } else { month + 9 };
    let day_of_year = (153 * shifted_month + 2) / 5 + i64::from(day) - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(millis: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_millis(millis)
    }

    #[test]
    fn formats_like_javascript_to_iso_string() {
        assert_eq!(iso8601(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
        // new Date(1700000000123).toISOString()
        assert_eq!(iso8601(at(1_700_000_000_123)), "2023-11-14T22:13:20.123Z");
        // new Date(Date.UTC(2024, 1, 29, 23, 59, 59, 999)).toISOString()
        assert_eq!(iso8601(at(1_709_251_199_999)), "2024-02-29T23:59:59.999Z");
        assert_eq!(iso8601(at(1_709_251_200_000)), "2024-03-01T00:00:00.000Z");
        assert_eq!(iso8601(at(4_102_444_800_000)), "2100-01-01T00:00:00.000Z");
    }

    #[test]
    fn parses_what_it_formats() {
        for millis in [0, 1_700_000_000_123, 1_709_251_199_999, 951_782_400_000] {
            assert_eq!(parse_iso8601(&iso8601(at(millis))), Some(at(millis)));
        }
        assert_eq!(
            parse_iso8601("2023-11-14T22:13:20Z"),
            Some(at(1_700_000_000_000))
        );
    }

    #[test]
    fn rejects_other_formats() {
        for text in [
            "",
            "2023-11-14",
            "2023-11-14T22:13:20",
            "2023-11-14T22:13:20.123+01:00",
            "2023-13-14T22:13:20.123Z",
            "2023-02-29T22:13:20.123Z",
            "2023-11-14T24:13:20.123Z",
            "1969-12-31T23:59:59.999Z",
            "2023-11-14T22:13:20.1Z",
            "+023-11-14T22:13:20.123Z",
            "2023-11-14 22:13:20.123Z",
        ] {
            assert_eq!(parse_iso8601(text), None, "{text:?}");
        }
    }

    #[test]
    fn sorts_as_strings_in_time_order() {
        let earlier = iso8601(at(1_700_000_000_000));
        let later = iso8601(at(1_700_000_000_001));
        assert!(later > earlier);
    }
}

/// Timestamps are read back from files Folio keeps, which may be damaged or
/// edited: only what Folio writes is accepted, and it reads back exactly.
#[cfg(test)]
mod properties {
    use super::*;
    use crate::fuzz;
    use proptest::prelude::*;

    /// The last millisecond with a four-digit year.
    const LAST: u64 = 253_402_300_799_999;

    fn at(millis: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_millis(millis)
    }

    fn timestamp_like() -> impl Strategy<Value = String> {
        prop_oneof![
            "[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{3})?Z",
            "[0-9+-]{4,5}-[0-9]{1,2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,4})?(Z|[+-][0-9]{2}:[0-9]{2})?",
            fuzz::text(),
        ]
    }

    proptest! {
        #![proptest_config(fuzz::config(1024))]

        #[test]
        fn reads_back_every_time_it_writes(millis in 0..=LAST) {
            let text = iso8601(at(millis));
            prop_assert_eq!(text.len(), 24);
            prop_assert_eq!(parse_iso8601(&text), Some(at(millis)));
        }

        /// What it accepts is what it would write (maybe without the
        /// milliseconds); it never guesses.
        #[test]
        fn accepts_only_what_it_writes(text in timestamp_like()) {
            if let Some(time) = parse_iso8601(&text) {
                let written = iso8601(time);
                if text.len() == 20 {
                    prop_assert_eq!(written, format!("{}.000Z", &text[..19]));
                } else {
                    prop_assert_eq!(written, text);
                }
            }
        }

        #[test]
        fn sorts_like_the_times_it_writes(a in 0..=LAST, b in 0..=LAST) {
            prop_assert_eq!(iso8601(at(a)).cmp(&iso8601(at(b))), a.cmp(&b));
        }
    }
}
