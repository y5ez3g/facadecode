//! Path vectors for the routes exchanged by directly connected machines.

use std::collections::{BTreeMap, BTreeSet};

/// The protocol uses the lowercase, hyphenated spelling of RFC 9562 version 4 UUIDs.
pub(crate) fn is_uuid_v4(id: &str) -> bool {
    let bytes = id.as_bytes();
    bytes.len() == 36
        && bytes[14] == b'4'
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
        && bytes.iter().enumerate().all(|(at, &byte)| match at {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'),
        })
}

/// Converts a peer's advertised path into a local path. `None` means we are already on it.
pub(super) fn through(
    local: &str,
    peer: &str,
    destination: &str,
    advertised: Vec<String>,
) -> Result<Option<Vec<String>>, &'static str> {
    if advertised.iter().any(|hop| hop == local) {
        return Ok(None);
    }
    if destination == peer && advertised.is_empty() {
        return Ok(Some(vec![peer.to_owned()]));
    }
    if advertised.last().is_none_or(|last| last != destination) {
        return Err("the route does not end at the advertised machine");
    }
    let mut seen = BTreeSet::from([peer]);
    if advertised.iter().any(|hop| !seen.insert(hop.as_str())) {
        return Err("the advertised route repeats a machine");
    }
    let mut path = Vec::with_capacity(advertised.len() + 1);
    path.push(peer.to_owned());
    path.extend(advertised);
    Ok(Some(path))
}

/// Shortest first, then the lexicographic order of first-hop machine IDs.
pub(super) fn preferred(candidate: &[String], current: &[String]) -> bool {
    (candidate.len(), candidate.first()) < (current.len(), current.first())
}

#[derive(Debug)]
pub(super) struct Conflict {
    pub(super) machine_id: String,
    pub(super) paths: [String; 2],
}

/// Compares all live routes, including those that were passed over in route selection.
#[derive(Default)]
pub(super) struct LiveIdentities(BTreeMap<String, (String, String)>);

impl LiveIdentities {
    pub(super) fn observe(
        &mut self,
        machine_id: &str,
        boot_id: &str,
        describe: impl FnOnce() -> String,
    ) -> Result<(), Conflict> {
        match self.0.get(machine_id) {
            Some((known, path)) if known != boot_id => Err(Conflict {
                machine_id: machine_id.to_owned(),
                paths: [path.clone(), describe()],
            }),
            Some(_) => Ok(()),
            None => {
                self.0
                    .insert(machine_id.to_owned(), (boot_id.to_owned(), describe()));
                Ok(())
            }
        }
    }
}
