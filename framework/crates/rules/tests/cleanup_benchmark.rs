use facade_base::model::message::check_message_text;
use std::hint::black_box;
use std::time::Instant;
use unicode_segmentation::UnicodeSegmentation;

#[test]
#[ignore = "manual timing with an optimized build"]
fn codex_cleanup_count() {
    let codex = &facade_rules::find("codex").unwrap().unwrap().paste;
    for flags in [999, 1_998, 3_996] {
        let text = format!("paste: {}!", "🇺🇸".repeat(flags));
        check_message_text(&text).unwrap();
        let expected = flags + 8;
        measure("grapheme count", &text, expected, |text| {
            text.graphemes(false).count()
        });
        measure("cleanup count", &text, expected, |text| {
            codex.backspace_count(text)
        });
    }
}

fn measure(name: &str, text: &str, expected: usize, count: impl Fn(&str) -> usize) {
    assert_eq!(count(text), expected);
    let mut micros = [0.0; 5];
    for sample in &mut micros {
        let start = Instant::now();
        let result = black_box(count(black_box(text)));
        *sample = start.elapsed().as_secs_f64() * 1_000_000.0;
        assert_eq!(result, expected);
    }
    micros.sort_by(f64::total_cmp);
    println!(
        "{name}, bytes={}, count={expected}, median_us={:.2}, min_us={:.2}, max_us={:.2}",
        text.len(),
        micros[2],
        micros[0],
        micros[4]
    );
}
