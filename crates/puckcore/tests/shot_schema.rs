// SPDX-License-Identifier: GPL-2.0-or-later
//! The JSON schemas in `data/schema/` match the Rust shot types.
//!
//! Serialises the defaults and variants that cover every enum variant (and a
//! solver result with every list populated), then checks both directions:
//! every key the Rust types produce is declared in the schema at the same
//! place, and every property the schema declares is produced by some
//! instance. Scalar types, `const` values and numeric bounds are checked too.
//! Finally every bounded number of the spec schema (and every `maxItems`) is
//! pushed just outside its bound: the solver's validation must reject it,
//! naming that field, so the schema and the validation stay in step.
//!
//! No JSON library is used (the core keeps its dependency list minimal): a
//! small serde `Serializer` and `Deserializer` map the Rust types to and from
//! a value tree, and a small parser reads the schema files. Runs when the
//! `serde` feature is on, as in the workspace test run.

#![cfg(feature = "serde")]

use std::collections::BTreeSet;
use std::fmt;

use puckcore::shot::*;
mod common;
use serde::Serialize;
use serde::de::{self, DeserializeOwned, Visitor};
use serde::ser::{self, SerializeMap, SerializeSeq, SerializeStruct, SerializeTuple};

// ----- A value tree ------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
enum Value {
    Null,
    Bool(bool),
    Int(i128),
    Num(f64),
    Str(String),
    Arr(Vec<Value>),
    Obj(Vec<(String, Value)>),
}

impl Value {
    fn get(&self, key: &str) -> Option<&Value> {
        match self {
            Value::Obj(fields) => fields.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    fn as_str(&self) -> Option<&str> {
        match self {
            Value::Str(s) => Some(s),
            _ => None,
        }
    }
}

// ----- Serialising into the tree --------------------------------------------------

#[derive(Debug)]
struct Error(String);

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

impl ser::Error for Error {
    fn custom<T: fmt::Display>(msg: T) -> Self {
        Error(msg.to_string())
    }
}

impl de::Error for Error {
    fn custom<T: fmt::Display>(msg: T) -> Self {
        Error(msg.to_string())
    }
}

// ----- Deserialising from the tree ------------------------------------------------

fn from_value<T: DeserializeOwned>(v: Value) -> Result<T, Error> {
    T::deserialize(v)
}

struct SeqDe(std::vec::IntoIter<Value>);

impl<'de> de::SeqAccess<'de> for SeqDe {
    type Error = Error;
    fn next_element_seed<T: de::DeserializeSeed<'de>>(
        &mut self,
        seed: T,
    ) -> Result<Option<T::Value>, Error> {
        self.0.next().map(|v| seed.deserialize(v)).transpose()
    }
}

struct MapDe {
    it: std::vec::IntoIter<(String, Value)>,
    value: Option<Value>,
}

impl<'de> de::MapAccess<'de> for MapDe {
    type Error = Error;
    fn next_key_seed<K: de::DeserializeSeed<'de>>(
        &mut self,
        seed: K,
    ) -> Result<Option<K::Value>, Error> {
        match self.it.next() {
            Some((k, v)) => {
                self.value = Some(v);
                seed.deserialize(Value::Str(k)).map(Some)
            }
            None => Ok(None),
        }
    }
    fn next_value_seed<V: de::DeserializeSeed<'de>>(&mut self, seed: V) -> Result<V::Value, Error> {
        seed.deserialize(self.value.take().expect("a key first"))
    }
}

impl<'de> de::Deserializer<'de> for Value {
    type Error = Error;
    fn deserialize_any<V: Visitor<'de>>(self, v: V) -> Result<V::Value, Error> {
        match self {
            Value::Null => v.visit_unit(),
            Value::Bool(b) => v.visit_bool(b),
            Value::Int(i) if i >= 0 => v.visit_u64(i as u64),
            Value::Int(i) => v.visit_i64(i as i64),
            Value::Num(x) => v.visit_f64(x),
            Value::Str(s) => v.visit_string(s),
            Value::Arr(items) => v.visit_seq(SeqDe(items.into_iter())),
            Value::Obj(fields) => v.visit_map(MapDe {
                it: fields.into_iter(),
                value: None,
            }),
        }
    }
    fn deserialize_option<V: Visitor<'de>>(self, v: V) -> Result<V::Value, Error> {
        match self {
            Value::Null => v.visit_none(),
            other => v.visit_some(other),
        }
    }
    fn deserialize_f64<V: Visitor<'de>>(self, v: V) -> Result<V::Value, Error> {
        match self {
            Value::Int(i) => v.visit_f64(i as f64),
            other => other.deserialize_any(v),
        }
    }
    fn deserialize_enum<V: Visitor<'de>>(
        self,
        _name: &'static str,
        _variants: &'static [&'static str],
        visitor: V,
    ) -> Result<V::Value, Error> {
        match self {
            Value::Str(value) => {
                visitor.visit_enum(de::value::StringDeserializer::<Error>::new(value))
            }
            other => other.deserialize_any(visitor),
        }
    }
    serde::forward_to_deserialize_any! {
        bool i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 f32 char str string bytes byte_buf
        unit unit_struct newtype_struct seq tuple tuple_struct map struct identifier
        ignored_any
    }
}

struct ToValue;

struct Seq(Vec<Value>);

struct Map {
    fields: Vec<(String, Value)>,
    key: Option<String>,
}

fn to_value<T: Serialize + ?Sized>(v: &T) -> Value {
    v.serialize(ToValue).expect("serialisable")
}

impl ser::Serializer for ToValue {
    type Ok = Value;
    type Error = Error;
    type SerializeSeq = Seq;
    type SerializeTuple = Seq;
    type SerializeTupleStruct = Seq;
    type SerializeTupleVariant = ser::Impossible<Value, Error>;
    type SerializeMap = Map;
    type SerializeStruct = Map;
    type SerializeStructVariant = ser::Impossible<Value, Error>;

    fn serialize_bool(self, v: bool) -> Result<Value, Error> {
        Ok(Value::Bool(v))
    }
    fn serialize_i8(self, v: i8) -> Result<Value, Error> {
        Ok(Value::Int(v.into()))
    }
    fn serialize_i16(self, v: i16) -> Result<Value, Error> {
        Ok(Value::Int(v.into()))
    }
    fn serialize_i32(self, v: i32) -> Result<Value, Error> {
        Ok(Value::Int(v.into()))
    }
    fn serialize_i64(self, v: i64) -> Result<Value, Error> {
        Ok(Value::Int(v.into()))
    }
    fn serialize_u8(self, v: u8) -> Result<Value, Error> {
        Ok(Value::Int(v.into()))
    }
    fn serialize_u16(self, v: u16) -> Result<Value, Error> {
        Ok(Value::Int(v.into()))
    }
    fn serialize_u32(self, v: u32) -> Result<Value, Error> {
        Ok(Value::Int(v.into()))
    }
    fn serialize_u64(self, v: u64) -> Result<Value, Error> {
        Ok(Value::Int(v.into()))
    }
    fn serialize_f32(self, v: f32) -> Result<Value, Error> {
        Ok(Value::Num(v.into()))
    }
    fn serialize_f64(self, v: f64) -> Result<Value, Error> {
        Ok(Value::Num(v))
    }
    fn serialize_char(self, v: char) -> Result<Value, Error> {
        Ok(Value::Str(v.to_string()))
    }
    fn serialize_str(self, v: &str) -> Result<Value, Error> {
        Ok(Value::Str(v.to_string()))
    }
    fn serialize_bytes(self, _: &[u8]) -> Result<Value, Error> {
        Err(Error("bytes are not used by the shot types".into()))
    }
    fn serialize_none(self) -> Result<Value, Error> {
        Ok(Value::Null)
    }
    fn serialize_some<T: Serialize + ?Sized>(self, v: &T) -> Result<Value, Error> {
        v.serialize(self)
    }
    fn serialize_unit(self) -> Result<Value, Error> {
        Ok(Value::Null)
    }
    fn serialize_unit_struct(self, _: &'static str) -> Result<Value, Error> {
        Ok(Value::Null)
    }
    fn serialize_unit_variant(
        self,
        _: &'static str,
        _: u32,
        variant: &'static str,
    ) -> Result<Value, Error> {
        Ok(Value::Str(variant.to_string()))
    }
    fn serialize_newtype_struct<T: Serialize + ?Sized>(
        self,
        _: &'static str,
        v: &T,
    ) -> Result<Value, Error> {
        v.serialize(self)
    }
    fn serialize_newtype_variant<T: Serialize + ?Sized>(
        self,
        _: &'static str,
        _: u32,
        variant: &'static str,
        v: &T,
    ) -> Result<Value, Error> {
        Ok(Value::Obj(vec![(variant.to_string(), to_value(v))]))
    }
    fn serialize_seq(self, _: Option<usize>) -> Result<Seq, Error> {
        Ok(Seq(Vec::new()))
    }
    fn serialize_tuple(self, _: usize) -> Result<Seq, Error> {
        Ok(Seq(Vec::new()))
    }
    fn serialize_tuple_struct(self, _: &'static str, _: usize) -> Result<Seq, Error> {
        Ok(Seq(Vec::new()))
    }
    fn serialize_tuple_variant(
        self,
        _: &'static str,
        _: u32,
        _: &'static str,
        _: usize,
    ) -> Result<Self::SerializeTupleVariant, Error> {
        Err(Error(
            "tuple variants are not used by the shot types".into(),
        ))
    }
    fn serialize_map(self, _: Option<usize>) -> Result<Map, Error> {
        Ok(Map {
            fields: Vec::new(),
            key: None,
        })
    }
    fn serialize_struct(self, _: &'static str, _: usize) -> Result<Map, Error> {
        self.serialize_map(None)
    }
    fn serialize_struct_variant(
        self,
        _: &'static str,
        _: u32,
        _: &'static str,
        _: usize,
    ) -> Result<Self::SerializeStructVariant, Error> {
        Err(Error(
            "externally tagged struct variants are not used".into(),
        ))
    }
}

impl SerializeSeq for Seq {
    type Ok = Value;
    type Error = Error;
    fn serialize_element<T: Serialize + ?Sized>(&mut self, v: &T) -> Result<(), Error> {
        self.0.push(to_value(v));
        Ok(())
    }
    fn end(self) -> Result<Value, Error> {
        Ok(Value::Arr(self.0))
    }
}

impl SerializeTuple for Seq {
    type Ok = Value;
    type Error = Error;
    fn serialize_element<T: Serialize + ?Sized>(&mut self, v: &T) -> Result<(), Error> {
        SerializeSeq::serialize_element(self, v)
    }
    fn end(self) -> Result<Value, Error> {
        SerializeSeq::end(self)
    }
}

impl ser::SerializeTupleStruct for Seq {
    type Ok = Value;
    type Error = Error;
    fn serialize_field<T: Serialize + ?Sized>(&mut self, v: &T) -> Result<(), Error> {
        SerializeSeq::serialize_element(self, v)
    }
    fn end(self) -> Result<Value, Error> {
        SerializeSeq::end(self)
    }
}

impl SerializeMap for Map {
    type Ok = Value;
    type Error = Error;
    fn serialize_key<T: Serialize + ?Sized>(&mut self, k: &T) -> Result<(), Error> {
        match to_value(k) {
            Value::Str(s) => {
                self.key = Some(s);
                Ok(())
            }
            other => Err(Error(format!("non-string key {other:?}"))),
        }
    }
    fn serialize_value<T: Serialize + ?Sized>(&mut self, v: &T) -> Result<(), Error> {
        let k = self
            .key
            .take()
            .ok_or_else(|| Error("value without key".into()))?;
        self.fields.push((k, to_value(v)));
        Ok(())
    }
    fn end(self) -> Result<Value, Error> {
        Ok(Value::Obj(self.fields))
    }
}

impl SerializeStruct for Map {
    type Ok = Value;
    type Error = Error;
    fn serialize_field<T: Serialize + ?Sized>(
        &mut self,
        key: &'static str,
        v: &T,
    ) -> Result<(), Error> {
        self.fields.push((key.to_string(), to_value(v)));
        Ok(())
    }
    fn end(self) -> Result<Value, Error> {
        Ok(Value::Obj(self.fields))
    }
}

// ----- A small JSON parser for the schema files ------------------------------------

struct Parser<'a> {
    s: &'a [u8],
    i: usize,
}

impl Parser<'_> {
    fn ws(&mut self) {
        while self.i < self.s.len() && self.s[self.i].is_ascii_whitespace() {
            self.i += 1;
        }
    }

    fn eat(&mut self, c: u8) {
        self.ws();
        assert_eq!(
            self.s[self.i], c,
            "expected '{}' at byte {}",
            c as char, self.i
        );
        self.i += 1;
    }

    fn value(&mut self) -> Value {
        self.ws();
        match self.s[self.i] {
            b'{' => {
                self.i += 1;
                let mut fields = Vec::new();
                self.ws();
                if self.s[self.i] == b'}' {
                    self.i += 1;
                    return Value::Obj(fields);
                }
                loop {
                    self.ws();
                    let Value::Str(k) = self.value() else {
                        panic!("object key at byte {}", self.i)
                    };
                    self.eat(b':');
                    let v = self.value();
                    fields.push((k, v));
                    self.ws();
                    match self.s[self.i] {
                        b',' => self.i += 1,
                        b'}' => {
                            self.i += 1;
                            return Value::Obj(fields);
                        }
                        c => panic!("unexpected '{}' at byte {}", c as char, self.i),
                    }
                }
            }
            b'[' => {
                self.i += 1;
                let mut items = Vec::new();
                self.ws();
                if self.s[self.i] == b']' {
                    self.i += 1;
                    return Value::Arr(items);
                }
                loop {
                    items.push(self.value());
                    self.ws();
                    match self.s[self.i] {
                        b',' => self.i += 1,
                        b']' => {
                            self.i += 1;
                            return Value::Arr(items);
                        }
                        c => panic!("unexpected '{}' at byte {}", c as char, self.i),
                    }
                }
            }
            b'"' => {
                self.i += 1;
                let mut out = Vec::new();
                while self.s[self.i] != b'"' {
                    if self.s[self.i] == b'\\' {
                        self.i += 1;
                        match self.s[self.i] {
                            b'n' => out.push(b'\n'),
                            b't' => out.push(b'\t'),
                            b'u' => {
                                let hex =
                                    std::str::from_utf8(&self.s[self.i + 1..self.i + 5]).unwrap();
                                let c =
                                    char::from_u32(u32::from_str_radix(hex, 16).unwrap()).unwrap();
                                let mut buf = [0u8; 4];
                                out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
                                self.i += 4;
                            }
                            c => out.push(c),
                        }
                    } else {
                        out.push(self.s[self.i]);
                    }
                    self.i += 1;
                }
                self.i += 1;
                Value::Str(String::from_utf8(out).expect("UTF-8"))
            }
            b't' => {
                self.i += 4;
                Value::Bool(true)
            }
            b'f' => {
                self.i += 5;
                Value::Bool(false)
            }
            b'n' => {
                self.i += 4;
                Value::Null
            }
            _ => {
                let start = self.i;
                while self.i < self.s.len() && b"+-0123456789.eE".contains(&self.s[self.i]) {
                    self.i += 1;
                }
                let text = std::str::from_utf8(&self.s[start..self.i]).unwrap();
                if text.contains(['.', 'e', 'E']) {
                    Value::Num(text.parse().unwrap())
                } else {
                    Value::Int(text.parse().unwrap())
                }
            }
        }
    }
}

fn load_schema(name: &str) -> Value {
    let path = format!("{}/../../data/schema/{name}", env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
    let mut p = Parser {
        s: text.as_bytes(),
        i: 0,
    };
    p.value()
}

// ----- Walking an instance against a schema ------------------------------------

struct Walk<'a> {
    root: &'a Value,
    visited: BTreeSet<String>,
    errors: Vec<String>,
}

impl<'a> Walk<'a> {
    /// Follows `$ref` (directly or wrapped in `allOf`); returns the node and
    /// the definition name it came from.
    fn resolve(&self, node: &'a Value, name: &str) -> (&'a Value, String) {
        if let Some(r) = node.get("$ref").and_then(Value::as_str) {
            let def = r.strip_prefix("#/$defs/").expect("local refs only");
            let target = self
                .root
                .get("$defs")
                .and_then(|d| d.get(def))
                .expect("defined");
            return (target, def.to_string());
        }
        if let Some(Value::Arr(all)) = node.get("allOf") {
            return self.resolve(&all[0], name);
        }
        (node, name.to_string())
    }

    fn check(&mut self, schema: &'a Value, value: &Value, path: &str, name: &str) {
        let (schema, name) = self.resolve(schema, name);
        if let Some(c) = schema.get("const") {
            if c != value {
                self.errors
                    .push(format!("{path}: {value:?} is not the const {c:?}"));
            }
            return;
        }
        match value {
            Value::Obj(fields) => {
                let (node, label) = match schema.get("oneOf") {
                    Some(Value::Arr(branches)) => {
                        let tag = value.get("type").and_then(Value::as_str).unwrap_or("");
                        let branch = branches.iter().find(|b| {
                            b.get("properties")
                                .and_then(|p| p.get("type"))
                                .and_then(|t| t.get("const"))
                                .and_then(Value::as_str)
                                == Some(tag)
                        });
                        match branch {
                            Some(b) => (b, format!("{name}[{tag}]")),
                            None => {
                                self.errors
                                    .push(format!("{path}: no schema branch for type {tag:?}"));
                                return;
                            }
                        }
                    }
                    _ => (schema, name.clone()),
                };
                // An optional object uses the standard nullable type array.
                let object_allowed = match node.get("type") {
                    Some(Value::Str(t)) => t == "object",
                    Some(Value::Arr(types)) => types.iter().any(|t| t.as_str() == Some("object")),
                    _ => false,
                };
                if !object_allowed {
                    self.errors.push(format!("{path}: schema is not an object"));
                }
                let props = node.get("properties");
                for (k, v) in fields {
                    match props.and_then(|p| p.get(k)) {
                        Some(sub) => {
                            self.visited.insert(format!("{label}.{k}"));
                            self.check(sub, v, &format!("{path}.{k}"), &format!("{label}.{k}"));
                        }
                        None => self.errors.push(format!("{path}.{k}: not in the schema")),
                    }
                }
            }
            Value::Arr(items) => {
                if let Some(Value::Arr(prefix)) = schema.get("prefixItems") {
                    for (i, (it, sub)) in items.iter().zip(prefix).enumerate() {
                        self.check(sub, it, &format!("{path}[{i}]"), &name);
                    }
                } else if let Some(sub) = schema.get("items") {
                    for (i, it) in items.iter().enumerate() {
                        self.check(sub, it, &format!("{path}[{i}]"), &name);
                    }
                } else {
                    self.errors.push(format!("{path}: schema has no items"));
                }
            }
            scalar => {
                let kind = match scalar {
                    Value::Null => "null",
                    Value::Bool(_) => "boolean",
                    Value::Int(_) => "integer",
                    Value::Num(_) => "number",
                    Value::Str(_) => "string",
                    _ => unreachable!(),
                };
                let allowed: Vec<&str> = match schema.get("type") {
                    Some(Value::Str(t)) => vec![t.as_str()],
                    Some(Value::Arr(ts)) => ts.iter().filter_map(Value::as_str).collect(),
                    _ => vec![],
                };
                let ok =
                    allowed.contains(&kind) || (kind == "integer" && allowed.contains(&"number"));
                if !ok {
                    self.errors
                        .push(format!("{path}: {kind} not allowed by {allowed:?}"));
                }
                if let Some(x) = number(scalar) {
                    let b = Bounds::of(schema);
                    if !b.contains(x) {
                        self.errors
                            .push(format!("{path}: {x} outside the schema bounds {b:?}"));
                    }
                }
            }
        }
    }
}

fn number(v: &Value) -> Option<f64> {
    match v {
        Value::Int(i) => Some(*i as f64),
        Value::Num(x) => Some(*x),
        _ => None,
    }
}

/// Numeric bounds of a schema node.
#[derive(Clone, Copy, Debug, Default)]
struct Bounds {
    min: Option<f64>,
    max: Option<f64>,
    xmin: Option<f64>,
    xmax: Option<f64>,
}

impl Bounds {
    fn of(node: &Value) -> Self {
        let get = |k: &str| node.get(k).and_then(number);
        Self {
            min: get("minimum"),
            max: get("maximum"),
            xmin: get("exclusiveMinimum"),
            xmax: get("exclusiveMaximum"),
        }
    }

    fn contains(&self, x: f64) -> bool {
        self.min.is_none_or(|m| x >= m)
            && self.max.is_none_or(|m| x <= m)
            && self.xmin.is_none_or(|m| x > m)
            && self.xmax.is_none_or(|m| x < m)
    }

    /// Values just outside each bound.
    fn outside(&self) -> Vec<f64> {
        let below = |b: f64| if b == 0.0 { -1e-12 } else { b - b.abs() * 1e-9 };
        let above = |b: f64| if b == 0.0 { 1e-12 } else { b + b.abs() * 1e-9 };
        let mut v = Vec::new();
        v.extend(self.min.map(below));
        v.extend(self.max.map(above));
        v.extend(self.xmin);
        v.extend(self.xmax);
        v
    }
}

/// Every property the schema declares, labelled as the walk labels them.
fn declared(root: &Value) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let mut add_props = |label: &str, node: &Value| {
        if let Some(Value::Obj(props)) = node.get("properties") {
            for (k, _) in props {
                out.insert(format!("{label}.{k}"));
            }
        }
    };
    add_props("ROOT", root);
    if let Some(Value::Obj(defs)) = root.get("$defs") {
        for (name, def) in defs {
            match def.get("oneOf") {
                Some(Value::Arr(branches)) => {
                    for b in branches {
                        let tag = b
                            .get("properties")
                            .and_then(|p| p.get("type"))
                            .and_then(|t| t.get("const"))
                            .and_then(Value::as_str)
                            .unwrap();
                        add_props(&format!("{name}[{tag}]"), b);
                    }
                }
                _ => add_props(name, def),
            }
        }
    }
    out
}

/// Visited labels are field paths; the declared ones are per definition.
/// A definition property counts as covered when the walk visited it.
fn check_schema(file: &str, instances: &[Value]) {
    let root = load_schema(file);
    let mut walk = Walk {
        root: &root,
        visited: BTreeSet::new(),
        errors: Vec::new(),
    };
    for (i, v) in instances.iter().enumerate() {
        walk.check(&root, v, &format!("instance {i}"), "ROOT");
    }
    assert!(
        walk.errors.is_empty(),
        "{file}:\n{}",
        walk.errors.join("\n")
    );
    // The walk labels each key by the definition it belongs to.
    let covered = &walk.visited;
    let missing: Vec<String> = declared(&root)
        .into_iter()
        .filter(|d| !covered.contains(d))
        .collect();
    assert!(
        missing.is_empty(),
        "{file}: declared but never produced by the Rust types: {missing:?}"
    );
    println!(
        "{file}: {} keys checked, {} schema properties covered",
        walk.visited.len(),
        declared(&root).len()
    );
}

fn spec_instances() -> Vec<ShotSpec> {
    let mut v = ShotSpec::default();
    v.basket.outlet = Outlet::Pressurised {
        orifice_diameter_m: 4e-4,
        discharge_coefficient: 0.7,
    };
    v.machine.pump = Pump::Vibratory {
        free_flow_m3_s: 6e-6,
        stall_pressure_pa: 1.5e6,
        opv_pa: Some(1e6),
    };
    v.machine.phases = vec![
        Phase {
            control: Control::Flow { target_m3_s: 2e-6 },
            ramp_s: 1.0,
            limit: Some(4e5),
            exit: PhaseExit {
                time_s: Some(5.0),
                beverage_mass_kg: Some(0.002),
                pressure_pa: Some(3e5),
            },
        },
        Phase {
            control: Control::PumpFull,
            ramp_s: 0.0,
            limit: None,
            exit: PhaseExit::default(),
        },
    ];
    v.solubles.species = vec![SpeciesSpec {
        id: "caffeine".into(),
        mass_fraction: 0.012,
        ..SpeciesSpec::default()
    }];
    v.hydraulics.dissolution_porosity_share = Some(0.3);
    v.hydraulics.intraparticle_water_fraction = Some(1.0);
    v.hydraulics.pore_air = Relaxation {
        amplitude: 0.5,
        tau_s: 10.0,
    };
    v.hydraulics.pore_air_permeability_exponent = 3.0;
    v.hydraulics.poroelastic_pc_pa = None;
    v.machine.stop.time_s = Some(30.0);
    v.machine.hydraulic_compliance_m3_pa = 1e-11;
    v.chemistry = Some(common::chemistry_spec());
    let mut explore = v.clone();
    explore.numerics.depth_cells *= 5;
    explore.numerics.explore_cell = Some(ExploreRequest {
        column: 0,
        cell: 74,
        resolution: ExploreResolution::High,
    });
    vec![ShotSpec::default(), v, explore]
}

#[test]
fn spec_schema_matches_the_rust_types() {
    let instances: Vec<Value> = spec_instances().iter().map(to_value).collect();
    check_schema("shot-spec.schema.json", &instances);
}

#[test]
fn result_schema_matches_the_rust_types() {
    let instances: Vec<Value> = spec_instances()
        .iter()
        .map(|s| to_value(&simulate_shot(s).expect("valid spec")))
        .collect();
    // A result without first drops serialises `null` there.
    let mut choked = ShotSpec::default();
    choked.hydraulics.permeability_m2 = 1e-18;
    let mut all = instances;
    all.push(to_value(&simulate_shot(&choked).unwrap()));
    check_schema("shot-result.schema.json", &all);
}

#[test]
fn defaults_carry_the_schema_ids() {
    let v = to_value(&ShotSpec::default());
    assert_eq!(v.get("schema"), Some(&Value::Str(SHOT_SPEC_SCHEMA.into())));
    let r = to_value(&simulate_shot(&ShotSpec::default()).unwrap());
    assert_eq!(
        r.get("schema"),
        Some(&Value::Str(SHOT_RESULT_SCHEMA.into()))
    );
    // Integers stay integers, so the schema's integer types are checked.
    let n = v.get("numerics").unwrap();
    assert_eq!(n.get("tier"), Some(&Value::Int(1)));
}

#[test]
fn old_specs_without_startup_fields_keep_the_legacy_closure() {
    let expected = ShotSpec::default();
    let Value::Obj(mut root) = to_value(&expected) else {
        panic!("a shot spec is an object");
    };
    let (_, Value::Obj(hydraulics)) = root
        .iter_mut()
        .find(|(key, _)| key == "hydraulics")
        .unwrap()
    else {
        panic!("hydraulics is an object");
    };
    hydraulics.retain(|(key, _)| {
        !matches!(
            key.as_str(),
            "intraparticle_water_fraction" | "pore_air" | "pore_air_permeability_exponent"
        )
    });
    let restored: ShotSpec = from_value(Value::Obj(root)).expect("legacy JSON remains accepted");
    assert_eq!(restored, expected);
}

#[test]
fn old_specs_without_compliance_keep_the_algebraic_hydraulics() {
    let expected = ShotSpec::default();
    let Value::Obj(mut root) = to_value(&expected) else {
        panic!("a shot spec is an object");
    };
    let (_, Value::Obj(machine)) = root.iter_mut().find(|(key, _)| key == "machine").unwrap()
    else {
        panic!("machine is an object");
    };
    machine.retain(|(key, _)| key != "hydraulic_compliance_m3_pa");
    let restored: ShotSpec =
        from_value(Value::Obj(root)).expect("legacy machine JSON remains accepted");
    assert_eq!(restored, expected);
    assert_eq!(
        simulate_shot(&restored).unwrap(),
        simulate_shot(&expected).unwrap()
    );
}

#[test]
fn the_checker_catches_drift() {
    let parse = |t: &str| {
        let mut p = Parser {
            s: t.as_bytes(),
            i: 0,
        };
        p.value()
    };
    let schema = parse(
        r#"{"type": "object", "properties": {"a": {"type": "number"}, "b": {"type": "integer"}}}"#,
    );
    let run = |instance: &str| {
        let v = parse(instance);
        let mut walk = Walk {
            root: &schema,
            visited: BTreeSet::new(),
            errors: Vec::new(),
        };
        walk.check(&schema, &v, "x", "ROOT");
        (walk.errors, walk.visited)
    };
    // A key the schema does not declare, and a wrongly typed value.
    assert_eq!(run(r#"{"a": 1.5, "c": 2}"#).0.len(), 1);
    assert_eq!(run(r#"{"a": 1.5, "b": 2.5}"#).0.len(), 1);
    // A declared property nothing produces is left uncovered.
    let (errors, visited) = run(r#"{"a": 1.5}"#);
    assert!(errors.is_empty());
    assert!(!visited.contains("ROOT.b"));
    assert!(declared(&schema).contains("ROOT.b"));
}

// ----- The schema's bounds are the validation's ---------------------------------

#[derive(Clone, Debug)]
enum Seg {
    Key(String),
    Index(usize),
}

/// One mutation: set the value at `path` and expect `field` to be named.
#[derive(Clone, Debug)]
struct Case {
    path: Vec<Seg>,
    field: String,
    value: Value,
}

fn set(v: &mut Value, path: &[Seg], new: Value) {
    match (path.first(), v) {
        (None, v) => *v = new,
        (Some(Seg::Key(k)), Value::Obj(fields)) => {
            let slot = fields.iter_mut().find(|(n, _)| n == k).expect("key");
            set(&mut slot.1, &path[1..], new);
        }
        (Some(Seg::Index(i)), Value::Arr(items)) => set(&mut items[*i], &path[1..], new),
        _ => panic!("bad path"),
    }
}

/// Collects the out-of-bounds cases of an instance against the spec schema.
fn collect(
    walk: &Walk<'_>,
    schema: &Value,
    value: &Value,
    path: &mut Vec<Seg>,
    field: &str,
    out: &mut Vec<Case>,
) {
    let (schema, _) = walk.resolve(schema, "");
    let join = |k: &str| {
        if field.is_empty() {
            k.to_string()
        } else {
            format!("{field}.{k}")
        }
    };
    match value {
        Value::Obj(fields) => {
            let node = match schema.get("oneOf") {
                Some(Value::Arr(branches)) => {
                    let tag = value.get("type").and_then(Value::as_str).unwrap_or("");
                    branches
                        .iter()
                        .find(|b| {
                            b.get("properties")
                                .and_then(|p| p.get("type"))
                                .and_then(|t| t.get("const"))
                                .and_then(Value::as_str)
                                == Some(tag)
                        })
                        .expect("branch")
                }
                _ => schema,
            };
            for (k, v) in fields {
                if let Some(sub) = node.get("properties").and_then(|p| p.get(k)) {
                    path.push(Seg::Key(k.clone()));
                    collect(walk, sub, v, path, &join(k), out);
                    path.pop();
                }
            }
        }
        Value::Arr(items) => {
            // (A fixed-size tuple such as a profile point is checked by type.)
            let tuple = schema.get("prefixItems").is_some();
            if let (false, Some(max), Some(first)) = (
                tuple,
                schema.get("maxItems").and_then(number),
                items.first(),
            ) {
                let mut longer = items.clone();
                longer.resize(max as usize + 1, first.clone());
                out.push(Case {
                    path: path.clone(),
                    field: field.to_string(),
                    value: Value::Arr(longer),
                });
            }
            for (i, it) in items.iter().enumerate() {
                path.push(Seg::Index(i));
                let item_field = format!("{field}[{i}]");
                if let Some(Value::Arr(prefix)) = schema.get("prefixItems") {
                    // Points are named as a whole, e.g. basket.profile_m[1].
                    if let Value::Arr(parts) = it {
                        for (j, (part, sub)) in parts.iter().zip(prefix).enumerate() {
                            path.push(Seg::Index(j));
                            for x in Bounds::of(sub).outside() {
                                let _ = part;
                                out.push(Case {
                                    path: path.clone(),
                                    field: item_field.clone(),
                                    value: Value::Num(x),
                                });
                            }
                            path.pop();
                        }
                    }
                } else if let Some(sub) = schema.get("items") {
                    collect(walk, sub, it, path, &item_field, out);
                }
                path.pop();
            }
        }
        Value::Int(_) | Value::Num(_) => {
            let b = Bounds::of(schema);
            let values: Vec<Value> =
                if schema.get("type").and_then(Value::as_str) == Some("integer") {
                    // One below the minimum (when representable in an unsigned
                    // field) and one above the maximum.
                    b.min
                        .filter(|&m| m >= 1.0)
                        .map(|m| m as i128 - 1)
                        .into_iter()
                        .chain(b.max.map(|m| m as i128 + 1))
                        .map(Value::Int)
                        .collect()
                } else {
                    b.outside().into_iter().map(Value::Num).collect()
                };
            for value in values {
                out.push(Case {
                    path: path.clone(),
                    field: field.to_string(),
                    value,
                });
            }
        }
        _ => {}
    }
}

#[test]
fn schema_bounds_match_the_validation() {
    let root = load_schema("shot-spec.schema.json");
    let walk = Walk {
        root: &root,
        visited: BTreeSet::new(),
        errors: Vec::new(),
    };
    let mut total = 0;
    let mut failures = Vec::new();
    for spec in spec_instances() {
        let instance = to_value(&spec);
        // The instance itself round-trips through the value tree.
        let back: ShotSpec = from_value(instance.clone()).expect("round trip");
        assert_eq!(back, spec);
        let mut cases = Vec::new();
        collect(&walk, &root, &instance, &mut Vec::new(), "", &mut cases);
        for case in cases {
            let mut v = instance.clone();
            set(&mut v, &case.path, case.value.clone());
            let Ok(mutated) = from_value::<ShotSpec>(v) else {
                continue;
            };
            total += 1;
            match validate_shot_spec(&mutated) {
                Err(ShotError::InvalidSpec { field, .. }) if field == case.field => {}
                other => failures.push(format!(
                    "{} = {:?}: expected an error naming it, got {other:?}",
                    case.field, case.value
                )),
            }
        }
    }
    println!("{total} out-of-bounds values rejected by the validation");
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    assert!(total > 100, "{total}");
}
