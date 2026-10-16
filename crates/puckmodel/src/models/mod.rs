// SPDX-License-Identifier: GPL-2.0-or-later
//! The input models (PLAN §7.3; docs/model/input-models.md):
//! - [`bean`]: bean descriptors → composition, porosity, CO₂ (module B);
//! - [`grinder`]: grinder and setting, or a measured PSD → size classes (G);
//! - [`basket`]: basket geometry (P);
//! - [`prep`]: puck preparation → bed heterogeneity (P);
//! - [`machine`]: program, pump, thermal node, stop rule (M).

pub(crate) mod basket;
pub(crate) mod bean;
pub(crate) mod grinder;
pub(crate) mod machine;
pub(crate) mod prep;
