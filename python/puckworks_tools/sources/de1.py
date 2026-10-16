# SPDX-License-Identifier: GPL-2.0-or-later
"""Read selected DE1 ``.shot`` literal data without evaluating Tcl.

This is deliberately a data reader, not a Tcl interpreter. Braces and quotes only
delimit words; command, variable and backslash substitutions are never performed.
Selected numeric values must be plain finite decimal literals. Unknown metadata
is discarded, including wall clocks, machine identifiers and free text.
"""

from __future__ import annotations

import math
import re
import statistics
from collections.abc import Sequence
from typing import Any


class ShotFormatError(ValueError):
    """The selected shot data are malformed or unsupported."""


# Names intentionally distinguish scale/sensor measurements, firmware estimates,
# scale-derived rates and controller goals. A goal is not measured inlet flow.
CHANNELS = {
    "espresso_elapsed": "t_s",
    "espresso_pressure": "measured_pressure_bar",
    "espresso_weight": "scale_mass_g",
    "espresso_flow": "estimated_inlet_flow_ml_s",
    "espresso_flow_weight": "derived_scale_flow_g_s",
    "espresso_flow_weight_raw": "raw_derived_scale_flow_g_s",
    "espresso_temperature_basket": "measured_basket_temperature_c",
    "espresso_temperature_mix": "measured_mix_temperature_c",
    "espresso_water_dispensed": "estimated_water_dispensed_ml",
    "espresso_pressure_goal": "target_pressure_bar",
    "espresso_flow_goal": "target_flow_ml_s",
    "espresso_temperature_goal": "target_temperature_c",
}
REQUIRED_CHANNELS = ("espresso_elapsed", "espresso_pressure", "espresso_weight")
MAX_SHOT_BYTES = 2_000_000
MAX_SAMPLES = 100_000
_NUMBER = re.compile(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?\Z")
_KEY = re.compile(r"[A-Za-z_][A-Za-z0-9_:.-]*\Z")


def _literal_words(text: str, *, context: str) -> list[str]:
    """Split the literal subset of Tcl lists used in shot files.

    Braced words may nest. Backslash pairs are retained verbatim and only protect
    a delimiter while scanning; a selected numeric value containing one will fail
    numeric validation. Even ``[exec ...]`` and ``$variable`` remain inert text.
    No Tcl library, eval, shell or subprocess is used by this parser.
    """
    words: list[str] = []
    i = 0
    while i < len(text):
        if text[i].isspace():
            i += 1
            continue
        start = i
        if text[i] in '{"':
            opening = text[i]
            i += 1
            start = i
            depth = 1
            while i < len(text):
                char = text[i]
                if char == "\\":
                    if i + 1 == len(text):
                        raise ShotFormatError(f"{context}: unfinished escape")
                    i += 2
                    continue
                if opening == "{" and char == "{":
                    depth += 1
                    if depth > 128:
                        raise ShotFormatError(f"{context}: excessive brace nesting")
                elif (opening == "{" and char == "}") or (opening == '"' and char == '"'):
                    depth -= 1
                    if depth == 0:
                        break
                i += 1
            if depth:
                raise ShotFormatError(f"{context}: unterminated literal word")
            words.append(text[start:i])
            i += 1
            if i < len(text) and not text[i].isspace():
                raise ShotFormatError(f"{context}: missing whitespace after literal word")
        else:
            while i < len(text) and not text[i].isspace():
                if text[i] == "\\":
                    if i + 1 == len(text):
                        raise ShotFormatError(f"{context}: unfinished escape")
                    i += 2
                else:
                    i += 1
            words.append(text[start:i])
        if len(words) > 2 * MAX_SAMPLES:
            raise ShotFormatError(f"{context}: too many literal words")
    return words


def _literal_dict(text: str, *, context: str) -> dict[str, str]:
    words = _literal_words(text, context=context)
    if len(words) % 2:
        raise ShotFormatError(f"{context}: expected key/value pairs")
    result = {}
    for key, value in zip(words[::2], words[1::2]):
        if not _KEY.fullmatch(key):
            raise ShotFormatError(f"{context}: invalid literal key")
        if key in result:
            raise ShotFormatError(f"{context}: duplicate key {key}")
        result[key] = value
    return result


def _number(text: str, *, context: str) -> float:
    if not _NUMBER.fullmatch(text):
        raise ShotFormatError(f"{context}: expected a plain finite number")
    number = float(text)
    if not math.isfinite(number):
        raise ShotFormatError(f"{context}: non-finite number")
    return number


def _numeric_vector(text: str, *, context: str) -> list[float]:
    words = text.split()
    if not 2 <= len(words) <= MAX_SAMPLES:
        raise ShotFormatError(f"{context}: expected 2–{MAX_SAMPLES} samples")
    return [_number(word, context=context) for word in words]


_STEP_NUMBERS = {
    "seconds": "duration_s",
    "flow": "target_flow_ml_s",
    "pressure": "target_pressure_bar",
    "temperature": "target_temperature_c",
    "volume": "volume_limit_ml",
    "exit_flow_under": "exit_flow_under_ml_s",
    "exit_flow_over": "exit_flow_over_ml_s",
    "exit_pressure_under": "exit_pressure_under_bar",
    "exit_pressure_over": "exit_pressure_over_bar",
}
_STEP_ENUMS = {
    "pump": ("pump_control", {"flow", "pressure"}),
    "sensor": ("temperature_sensor", {"coffee", "water"}),
    "transition": ("transition", {"fast", "smooth"}),
    "exit_type": ("exit_type", {"flow_under", "flow_over", "pressure_under", "pressure_over"}),
}
_PROFILE_NUMBERS = {
    "final_desired_shot_weight_advanced": "desired_stop_weight_g",
    "final_desired_shot_volume_advanced": "desired_stop_volume_ml",
    "seconds_after_espresso_stop_to_continue_weighing": "post_stop_weighing_s",
    "stop_weight_before_seconds": "stop_weight_lead_s",
    "shot_weight_percentage_stop": "stop_weight_percent",
}


def _profile(settings: dict[str, str]) -> tuple[list[dict[str, Any]], dict[str, float]]:
    profile_settings = {}
    for key, normalized in _PROFILE_NUMBERS.items():
        if key in settings:
            value = _number(settings[key], context=f"settings.{key}")
            if value < 0:
                raise ShotFormatError(f"settings.{key}: negative control setting")
            profile_settings[normalized] = value
    if "advanced_shot" not in settings:
        return [], profile_settings
    raw_steps = _literal_words(settings["advanced_shot"], context="advanced_shot")
    if not 1 <= len(raw_steps) <= 64:
        raise ShotFormatError("advanced_shot: expected 1–64 steps")
    steps = []
    required = {"seconds", "flow", "pressure", "temperature", "pump", "sensor", "transition", "exit_if"}
    for index, raw_step in enumerate(raw_steps, 1):
        context = f"advanced_shot step {index}"
        raw = _literal_dict(raw_step, context=context)
        if missing := required.difference(raw):
            raise ShotFormatError(f"{context}: missing fields {', '.join(sorted(missing))}")
        step: dict[str, Any] = {"index": index}
        for key, normalized in _STEP_NUMBERS.items():
            if key in raw:
                value = _number(raw[key], context=f"{context}.{key}")
                if key != "temperature" and value < 0:
                    raise ShotFormatError(f"{context}.{key}: negative control setting")
                step[normalized] = value
        for key, (normalized, accepted) in _STEP_ENUMS.items():
            if key in raw:
                if raw[key] not in accepted:
                    raise ShotFormatError(f"{context}.{key}: unsupported control value")
                step[normalized] = raw[key]
        if raw["exit_if"] not in {"0", "1"}:
            raise ShotFormatError(f"{context}.exit_if: expected 0 or 1")
        step["exit_enabled"] = raw["exit_if"] == "1"
        if step["exit_enabled"] and "exit_type" not in step:
            raise ShotFormatError(f"{context}: enabled exit has no exit_type")
        if step["exit_enabled"] and f"exit_{step['exit_type']}" not in raw:
            raise ShotFormatError(f"{context}: enabled exit has no threshold")
        steps.append(step)
    return steps, profile_settings


def parse_shot(text: str | bytes, *, source_name: str | None = None) -> dict[str, Any]:
    """Return selected, aligned channels and privacy-filtered declared controls.

    Time is the original elapsed clock, without a shift. Signed scale readings,
    negative noise and downward steps are retained. The three required channels
    are elapsed time, pressure and scale mass; every other recognized channel is
    validated when present. No unknown metadata is included in the return value.
    ``source_name`` is used only in errors, not exported.
    """
    context = source_name or "shot"
    if len(text) > MAX_SHOT_BYTES:
        raise ShotFormatError(f"{context}: shot exceeds size limit")
    if isinstance(text, bytes):
        try:
            text = text.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise ShotFormatError(f"{context}: expected UTF-8 text") from exc
    raw = _literal_dict(text, context=context)
    if missing := set(REQUIRED_CHANNELS).difference(raw):
        raise ShotFormatError(f"{context}: missing channels {', '.join(sorted(missing))}")
    result: dict[str, Any] = {}
    for original, normalized in CHANNELS.items():
        if original in raw:
            result[normalized] = _numeric_vector(raw[original], context=f"{context}.{original}")
    times = result["t_s"]
    if any(t1 <= t0 for t0, t1 in zip(times, times[1:])):
        raise ShotFormatError(f"{context}: elapsed times must strictly increase")
    for normalized, values in result.items():
        if len(values) != len(times):
            raise ShotFormatError(f"{context}.{normalized}: sample count differs from elapsed time")
    settings = _literal_dict(raw["settings"], context=f"{context}.settings") if "settings" in raw else {}
    result["profile_steps"], result["profile_settings"] = _profile(settings)
    return result


def observed_summary(
    t_s: Sequence[float], scale_mass_g: Sequence[float], *, final_beverage_g: float | None = None,
) -> dict[str, Any]:
    """Descriptive signed-scale observables, with no clock or drip inference.

    Threshold time is the first upward adjacent crossing, linearly interpolated
    in the original samples. An initial reading already at/above the threshold
    is left-censored, and does not receive an invented crossing time.
    """
    if len(t_s) != len(scale_mass_g) or len(t_s) < 2:
        raise ValueError("observables require equal-length time/mass arrays with at least two samples")
    if not all(math.isfinite(x) for x in (*t_s, *scale_mass_g)):
        raise ValueError("observables require finite time/mass samples")
    intervals = [t1 - t0 for t0, t1 in zip(t_s, t_s[1:])]
    if any(dt <= 0 for dt in intervals):
        raise ValueError("observables require strictly increasing elapsed times")
    if final_beverage_g is not None and not math.isfinite(final_beverage_g):
        raise ValueError("annotated beverage mass must be finite")
    thresholds = []
    for threshold in (0.5, 1.0):
        observation: dict[str, Any] = {"mass_g": threshold, "time_s": None, "status": "not_reached"}
        if scale_mass_g[0] >= threshold:
            observation["status"] = "left_censored"
        else:
            for i in range(1, len(t_s)):
                if scale_mass_g[i - 1] < threshold <= scale_mass_g[i]:
                    fraction = (threshold - scale_mass_g[i - 1]) / (scale_mass_g[i] - scale_mass_g[i - 1])
                    observation.update(time_s=t_s[i - 1] + fraction * intervals[i - 1], status="observed")
                    break
        thresholds.append(observation)
    downward = [m0 - m1 for m0, m1 in zip(scale_mass_g, scale_mass_g[1:]) if m1 < m0]
    return {
        "sample_count": len(t_s),
        "elapsed_start_s": t_s[0],
        "elapsed_end_s": t_s[-1],
        "sample_interval_s": {"min": min(intervals), "median": statistics.median(intervals), "max": max(intervals)},
        "thresholds": thresholds,
        "final_logged_mass_g": scale_mass_g[-1],
        "annotated_minus_logged_mass_g": None if final_beverage_g is None else final_beverage_g - scale_mass_g[-1],
        "minimum_logged_mass_g": min(scale_mass_g),
        "negative_mass_samples": sum(m < 0 for m in scale_mass_g),
        "downward_mass_steps": len(downward),
        "largest_downward_mass_step_g": max(downward, default=0.0),
    }
