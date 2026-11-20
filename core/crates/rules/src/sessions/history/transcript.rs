use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::Path;
use std::time::SystemTime;

use facade_base::jsonrpc::ErrorBody;
use serde_json::Value;

use super::{if_present, metadata, store_error};

// Codex and Pi can put instructions and settings ahead of the first prompt.
const HEAD_BYTES: u64 = 1024 * 1024;
const TAIL_BYTES: u64 = 64 * 1024;

pub(super) struct Transcript {
    pub head: Vec<Value>,
    tail: Option<Vec<Value>>,
    pub modified_at: Option<SystemTime>,
}

impl Transcript {
    pub fn tail(&self) -> &[Value] {
        self.tail.as_deref().unwrap_or(&self.head)
    }
}

/// Reads complete JSON records within the metadata windows of a transcript.
pub(super) fn read(path: &Path, tail: bool) -> Result<Option<Transcript>, ErrorBody> {
    let Some(meta) = metadata(path)?.filter(|meta| meta.is_file()) else {
        return Ok(None);
    };
    let Some(mut file) = if_present(path, File::open(path))? else {
        return Ok(None);
    };
    let result = (|| {
        let len = meta.len();
        let mut bytes = Vec::new();
        (&mut file).take(HEAD_BYTES).read_to_end(&mut bytes)?;
        let mut head = bytes.split(|&byte| byte == b'\n');
        if len > HEAD_BYTES && !bytes.ends_with(b"\n") {
            head.next_back();
        }
        let head = records(head);
        let tail = if tail && len > TAIL_BYTES {
            file.seek(SeekFrom::Start(len - TAIL_BYTES - 1))?;
            let mut file = BufReader::new(file.take(TAIL_BYTES + 1));
            bytes.clear();
            file.read_until(b'\n', &mut bytes)?;
            bytes.clear();
            file.read_to_end(&mut bytes)?;
            Some(records(bytes.split(|&byte| byte == b'\n')))
        } else {
            None
        };
        Ok(Transcript {
            head,
            tail,
            modified_at: meta.modified().ok(),
        })
    })();
    result
        .map(Some)
        .map_err(|error: std::io::Error| store_error(path, error))
}

fn records<'a>(lines: impl Iterator<Item = &'a [u8]>) -> Vec<Value> {
    lines
        .filter_map(|line| serde_json::from_slice::<Value>(line).ok())
        .filter(Value::is_object)
        .collect()
}

pub(super) fn json_file(path: &Path) -> Result<Option<Value>, ErrorBody> {
    Ok(if_present(path, fs::read(path))?.and_then(|bytes| serde_json::from_slice(&bytes).ok()))
}

pub(super) fn latest<'a>(lines: &'a [Value], kind: &str, field: &str) -> Option<&'a str> {
    lines
        .iter()
        .rev()
        .filter(|line| line["type"] == kind)
        .find_map(|line| line[field].as_str())
}

pub(super) fn prompt_text(content: &Value) -> Option<&str> {
    content
        .as_str()
        .or_else(|| {
            content
                .as_array()?
                .iter()
                .filter(|part| part["type"] == "text")
                .find_map(|part| part["text"].as_str())
        })
        .filter(|text| !text.trim().is_empty() && !text.trim_start().starts_with('<'))
}

/// Both vendors that name the session in its JSONL filename put the UUID last.
pub(super) fn filename_uuid(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;
    super::uuid(stem.get(stem.len().checked_sub(36)?..)?)
}
