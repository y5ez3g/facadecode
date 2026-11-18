//! A tool call's arguments, normalized against the input schema. Collects missing arguments and
//! other problems for the caller to report.

use serde_json::{Map, Number, Value, json};

use super::Problems;

/// The arguments `given` to `tool`, read as its input `schema` describes them: each argument left
/// out takes its default, and absent arguments are none at all. Every problem goes to `problems`.
pub(super) fn read_arguments(
    tool: &str,
    schema: &Value,
    given: &Value,
    problems: &mut Problems,
) -> Map<String, Value> {
    let arguments = Owner::Arguments(tool);
    match given {
        Value::Null => read_fields(schema, &Map::new(), &arguments, problems),
        Value::Object(given) => read_fields(schema, given, &arguments, problems),
        other => {
            problems.add(format!(
                "the arguments must be an object, not {}",
                kind_of(other)
            ));
            Map::new()
        }
    }
}

/// What a set of fields belongs to: a tool's arguments, or an argument that is an object.
enum Owner<'a> {
    Arguments(&'a str),
    Field(&'a str),
}

impl Owner<'_> {
    fn path(&self, key: &str) -> String {
        match self {
            Owner::Arguments(_) => key.to_string(),
            Owner::Field(field) => format!("{field}.{key}"),
        }
    }

    fn note_unknown(&self, key: &str, problems: &mut Problems) {
        match self {
            Owner::Arguments(tool) => problems.add_unknown_argument(tool, key),
            Owner::Field(field) => problems.add(format!("{key} is not a field of {field}")),
        }
    }
}

/// The fields of object `given` that `schema` describes: those it does not name are problems, as are
/// the required ones left out; one left out with a default takes it.
fn read_fields(
    schema: &Value,
    given: &Map<String, Value>,
    owner: &Owner<'_>,
    problems: &mut Problems,
) -> Map<String, Value> {
    let no_fields = Map::new();
    let properties = schema["properties"].as_object().unwrap_or(&no_fields);
    let required = |key: &str| {
        schema["required"]
            .as_array()
            .is_some_and(|names| names.iter().any(|name| name.as_str() == Some(key)))
    };
    for key in given.keys().filter(|key| !properties.contains_key(*key)) {
        owner.note_unknown(key, problems);
    }
    let mut read = Map::new();
    for (key, property) in properties {
        let path = owner.path(key);
        match given.get(key) {
            Some(Value::String(_))
                if matches!(owner, Owner::Arguments("start_agent")) && key == "worktree" =>
            {
                problems.add(r#"worktree must be an object. Use {"branch": "topic"}"#);
            }
            Some(value) => {
                if let Some(value) = read_value(property, value, &path, problems) {
                    read.insert(key.clone(), value);
                }
            }
            None if required(key) => problems.missing.push(path),
            None => {
                if let Some(default) = property.get("default") {
                    read.insert(key.clone(), default.clone());
                }
            }
        }
    }
    read
}

/// One value, `field`, read as `schema` describes it: a string, a boolean, an integer, an array of
/// them, or an object of them. None where it has a problem.
fn read_value(
    schema: &Value,
    given: &Value,
    field: &str,
    problems: &mut Problems,
) -> Option<Value> {
    let kind = schema["type"].as_str().unwrap_or_default();
    // Some CLIs send a list as JSON text or as its one item alone, and an object as JSON text.
    if let Value::String(text) = given {
        let parsed = serde_json::from_str::<Value>(text).ok();
        match kind {
            "array" => {
                let list = parsed
                    .filter(Value::is_array)
                    .unwrap_or_else(|| json!([text]));
                return read_value(schema, &list, field, problems);
            }
            "object" => {
                if let Some(object) = parsed.filter(Value::is_object) {
                    return read_value(schema, &object, field, problems);
                }
            }
            _ => {}
        }
    }
    let found_before = problems.total();
    let at_most = |key: &str| schema[key].as_u64();
    let read = match (kind, given) {
        ("string", Value::String(text)) => {
            let length = text.chars().count() as u64;
            if at_most("minLength").is_some_and(|min| length < min) {
                problems.add(format!("{field} must not be empty"));
            } else if let Some(max) = at_most("maxLength").filter(|max| length > *max) {
                problems.add(format!(
                    "{field} has {length} characters; at most {max} are taken"
                ));
            }
            given.clone()
        }
        ("boolean", Value::Bool(_)) => given.clone(),
        ("integer", Value::Number(number)) if whole(number).is_some() => {
            let n = whole(number).unwrap_or_default();
            let min = schema["minimum"].as_i64().unwrap_or(i64::MIN);
            let max = schema["maximum"].as_i64().unwrap_or(i64::MAX);
            if n < min || n > max {
                problems.add(format!("{field} must be from {min} to {max}, not {n}"));
            }
            json!(n)
        }
        ("array", Value::Array(items)) => {
            let count = items.len() as u64;
            if let Some(min) = at_most("minItems").filter(|min| count < *min) {
                let plural = if min == 1 { "" } else { "s" };
                problems.add(format!("{field} must have at least {min} item{plural}"));
            } else if let Some(max) = at_most("maxItems").filter(|max| count > *max) {
                problems.add(format!(
                    "{field} has {count} items; at most {max} are taken"
                ));
            }
            let mut read = Vec::with_capacity(items.len());
            for (at, item) in items.iter().enumerate() {
                let path = format!("{field}[{at}]");
                read.extend(read_value(&schema["items"], item, &path, problems));
            }
            Value::Array(read)
        }
        ("object", Value::Object(fields)) => {
            Value::Object(read_fields(schema, fields, &Owner::Field(field), problems))
        }
        _ => {
            problems.add(format!(
                "{field} must be {}, not {}",
                kind_name(kind),
                kind_of(given)
            ));
            return None;
        }
    };
    (problems.total() == found_before).then_some(read)
}

/// A whole number, also written with a fraction of zero, such as `5.0`.
fn whole(number: &Number) -> Option<i64> {
    if let Some(n) = number.as_i64() {
        return Some(n);
    }
    let n = number.as_f64()?;
    (n.fract() == 0.0 && n.abs() < 9.0e15).then_some(n as i64)
}

/// A schema type in words.
fn kind_name(kind: &str) -> &str {
    match kind {
        "string" => "a string",
        "boolean" => "a boolean",
        "integer" => "an integer",
        "array" => "an array",
        "object" => "an object",
        other => other,
    }
}

/// What a given value is, in words.
fn kind_of(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "a boolean",
        Value::Number(number) if whole(number).is_some() => "an integer",
        Value::Number(_) => "a fractional number",
        Value::String(_) => "a string",
        Value::Array(_) => "an array",
        Value::Object(_) => "an object",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn schema() -> Value {
        json!({
            "type": "object",
            "properties": {
                "to": { "type": "string", "minLength": 1 },
                "text": { "type": "string", "minLength": 1, "maxLength": 5 },
                "ids": {
                    "type": "array", "items": { "type": "string", "minLength": 1 }, "minItems": 1,
                    "maxItems": 2,
                },
                "all": { "type": "boolean", "default": false },
                "limit": { "type": "integer", "minimum": 1, "maximum": 200, "default": 100 },
            },
            "required": ["to", "text"],
        })
    }

    fn checked(given: Value) -> Result<Map<String, Value>, Value> {
        let mut problems = Problems::default();
        let arguments = read_arguments("send_message", &schema(), &given, &mut problems);
        match problems.into_failure("send_message") {
            Some(failure) => Err(failure),
            None => Ok(arguments),
        }
    }

    /// An object's fields are read as its schema says, named by the object, and an object may come
    /// as JSON text.
    #[test]
    fn an_object_s_fields_are_checked_by_name_and_it_may_come_as_text() {
        let schema = json!({
            "type": "object",
            "properties": {
                "worktree": {
                    "type": "object",
                    "properties": {
                        "branch": { "type": "string", "minLength": 1 },
                        "base_ref": { "type": "string", "minLength": 1 },
                    },
                    "required": ["branch", "base_ref"],
                },
            },
        });
        let read = |given: Value| {
            let mut problems = Problems::default();
            let arguments = read_arguments("example", &schema, &given, &mut problems);
            problems.into_failure("example").map_or(Ok(arguments), Err)
        };
        let worktree = json!({ "branch": "review", "base_ref": "HEAD" });
        assert_eq!(
            read(json!({ "worktree": worktree })).unwrap()["worktree"],
            worktree
        );
        assert_eq!(
            read(json!({ "worktree": worktree.to_string() })).unwrap()["worktree"],
            worktree
        );
        let failure = read(json!({ "worktree": { "branch": "", "colour": "red" } })).unwrap_err();
        assert_eq!(
            failure["message"],
            "example requires worktree.base_ref; colour is not a field of worktree; \
             worktree.branch must not be empty; nothing was done"
        );
        assert_eq!(
            read(json!({ "worktree": 3 })).unwrap_err()["message"],
            "worktree must be an object, not an integer; nothing was done"
        );
    }

    #[test]
    fn arguments_get_their_defaults_and_lists_may_come_as_text() {
        let arguments = checked(json!({ "to": "#a2", "text": "hi", "ids": "#m4" })).unwrap();
        assert_eq!(
            Value::Object(arguments),
            json!({ "all": false, "ids": ["#m4"], "limit": 100, "text": "hi", "to": "#a2" })
        );
        assert_eq!(
            checked(json!({
                "to": "#a2", "text": "hi", "ids": "[\"#m4\",\"m5\"]",
            }))
            .unwrap()["ids"],
            json!(["#m4", "m5"])
        );
        assert_eq!(
            checked(json!({ "to": "#a2", "text": "hi", "limit": 5.0 })).unwrap()["limit"],
            json!(5),
            "a whole number written with a fraction"
        );
    }

    /// One failure names every problem: what is missing, then each other problem by its argument.
    #[test]
    fn every_problem_is_reported_together() {
        let failure = checked(
            json!({ "colour": "red", "limit": 0, "all": "yes", "ids": [], "text": "too long" }),
        )
        .unwrap_err();
        assert_eq!(failure["reason"], "invalid_argument");
        assert_eq!(
            failure["message"],
            "send_message requires to; colour is not an argument of send_message; text has 8 \
             characters; at most 5 are taken; ids must have at least 1 item; all must be a \
             boolean, not a string; limit must be from 1 to 200, not 0; nothing was done"
        );
        let invalid = checked(json!({ "to": "", "text": "hi", "ids": ["m1", ""], "limit": 2.5 }))
            .unwrap_err();
        assert_eq!(invalid["reason"], "invalid_argument");
        assert_eq!(
            invalid["message"],
            "to must not be empty; ids[1] must not be empty; limit must be an integer, not a \
             fractional number; nothing was done"
        );
        assert_eq!(
            checked(json!([1])).unwrap_err()["message"],
            "the arguments must be an object, not an array; nothing was done"
        );
        assert!(
            checked(Value::Null).unwrap_err()["message"]
                == "send_message requires to, text; nothing was done",
            "absent arguments are none"
        );
    }
}
