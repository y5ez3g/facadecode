//! Timestamps as both protocols and MCP write them: UTC, ISO 8601, to the millisecond.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

const SECONDS_PER_DAY: i64 = 86_400;
/// Days from 0000-03-01, where the calendar's eras begin, to 1970-01-01.
const EPOCH_FROM_ERA_START: i64 = 719_468;
/// Days in 400 years of the Gregorian calendar.
const DAYS_PER_ERA: i64 = 146_097;

/// `at` as `2026-11-09T17:22:05.123Z`. A time before 1970 is written as 1970's start.
pub fn iso_time(at: SystemTime) -> String {
    let since = at.duration_since(UNIX_EPOCH).unwrap_or_default();
    let seconds = since.as_secs() as i64;
    let (year, month, day) = date_of(seconds.div_euclid(SECONDS_PER_DAY));
    let of_day = seconds.rem_euclid(SECONDS_PER_DAY);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        of_day / 3600,
        of_day / 60 % 60,
        of_day % 60,
        since.subsec_millis()
    )
}

/// Now, as [`iso_time`] writes it.
pub fn iso_now() -> String {
    iso_time(SystemTime::now())
}

/// The time `text` names, where [`iso_time`] could have written it; None for anything else.
pub fn parse_iso_time(text: &str) -> Option<SystemTime> {
    const SHAPE: &[u8] = b"dddd-dd-ddTdd:dd:dd.dddZ";
    let bytes = text.as_bytes();
    let fits = bytes.len() == SHAPE.len()
        && bytes
            .iter()
            .zip(SHAPE)
            .all(|(byte, expected)| match expected {
                b'd' => byte.is_ascii_digit(),
                _ => byte == expected,
            });
    if !fits {
        return None;
    }
    let field = |from: usize, to: usize| -> i64 { text[from..to].parse().unwrap_or_default() };
    let (year, month, day) = (field(0, 4), field(5, 7), field(8, 10));
    let (hour, minute, second) = (field(11, 13), field(14, 16), field(17, 19));
    let valid = (1..=12).contains(&month)
        && (1..=31).contains(&day)
        && hour < 24
        && minute < 60
        && second < 60;
    if !valid {
        return None;
    }
    let seconds = days_of(year, month, day) * SECONDS_PER_DAY + hour * 3600 + minute * 60 + second;
    let millis = u64::try_from(seconds * 1000 + field(20, 23)).ok()?;
    Some(UNIX_EPOCH + Duration::from_millis(millis))
}

/// The date `days` after 1970-01-01, by Howard Hinnant's `civil_from_days`: count in eras of 400
/// years that start on 1 March, so that the leap day ends each year.
fn date_of(days: i64) -> (i64, i64, i64) {
    let from_era_start = days + EPOCH_FROM_ERA_START;
    let era = from_era_start.div_euclid(DAYS_PER_ERA);
    let day_of_era = from_era_start.rem_euclid(DAYS_PER_ERA);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_from_march = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_from_march + 2) / 5 + 1;
    let month = (month_from_march + 2) % 12 + 1;
    let year = era * 400 + year_of_era + i64::from(month <= 2);
    (year, month, day)
}

/// The days from 1970-01-01 to a date: [`date_of`] backwards (Hinnant's `days_from_civil`).
fn days_of(year: i64, month: i64, day: i64) -> i64 {
    let year = year - i64::from(month <= 2);
    let era = year.div_euclid(400);
    let year_of_era = year.rem_euclid(400);
    let month_from_march = (month + 9) % 12;
    let day_of_year = (153 * month_from_march + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * DAYS_PER_ERA + day_of_era - EPOCH_FROM_ERA_START
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, UNIX_EPOCH};

    use super::*;

    #[test]
    fn a_moment_is_written_as_iso_8601_in_utc_to_the_millisecond() {
        let at = |millis| UNIX_EPOCH + Duration::from_millis(millis);
        assert_eq!(iso_time(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_time(at(1_762_737_725_123)), "2025-11-10T01:22:05.123Z");
        assert_eq!(iso_time(at(951_782_400_500)), "2000-02-29T00:00:00.500Z");
        assert_eq!(iso_time(at(4_102_444_799_999)), "2099-12-31T23:59:59.999Z");
    }

    #[test]
    fn a_timestamp_reads_back_as_the_moment_it_was_written_from() {
        for millis in [
            0,
            1_762_737_725_123,
            951_782_400_500,
            951_868_799_999,
            4_102_444_799_999,
        ] {
            let at = UNIX_EPOCH + Duration::from_millis(millis);
            assert_eq!(parse_iso_time(&iso_time(at)), Some(at));
        }
        for text in [
            "2026-11-09T17:22:05.123",
            "2026-11-09 17:22:05.123Z",
            "2026-13-09T17:22:05.123Z",
            "+026-11-09T17:22:05.123Z",
            "1969-12-31T23:59:59.999Z",
        ] {
            assert_eq!(parse_iso_time(text), None, "{text}");
        }
    }
}
