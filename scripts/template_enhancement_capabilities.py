"""Shared evidence checks for named destinations, native content and motion."""
import math
import re


def image_reference_counts(metadata: dict) -> dict | None:
    supporting = metadata.get("supporting_images", {})
    if not isinstance(supporting, dict):
        return None
    keys = ([] if metadata.get("visual_mode") == "native_text" else ["hero"]) + list(supporting)
    counts = metadata.get("image_reference_counts", {key: 1 for key in keys})
    if (not isinstance(counts, dict) or set(counts) != set(keys)
        or any(type(value) is not int or value < 1 for value in counts.values())):
        return None
    return counts


def extended_evidence_ready(source: str, metadata: dict, qa: dict) -> bool:
    references = image_reference_counts(metadata)
    if references is None:
        return False
    for key, count in references.items():
        marker = "__HERO_IMAGE_URL__" if key == "hero" else f"__IMAGE_{key.upper()}_URL__"
        appearances = len(re.findall(r'<mj-image\b[^>]*\bsrc=["\x27]' + re.escape(marker) + r'["\x27]', source))
        appearances += len(re.findall(r'\bbackground-url=["\x27]' + re.escape(marker) + r'["\x27]', source))
        if source.count(marker) != count or appearances != count:
            return False
    if "image_reference_counts" in metadata:
        if qa.get("image_reference_counts") != references or (qa.get("editor_roundtrip") or {}).get("image_reference_edit_counts") != references:
            return False
    gallery = metadata.get("interactive_gallery")
    if gallery is not None:
        expected_ids = [f"pw-{group}-{number}" for group in ("top", "bottom") for number in range(1, 7)]
        if (not isinstance(gallery, dict) or gallery.get("groups") != ["top", "bottom"]
            or gallery.get("input_ids") != expected_ids or gallery.get("static_class") != "pw-static"):
            return False
        inputs = re.findall(r'<input\b[^>]*>', source)
        for control_id in expected_ids:
            matches = [tag for tag in inputs if re.search(r'\bid=["\x27]' + control_id + r'["\x27]', tag)]
            group = control_id.split("-")[1]
            if (len(matches) != 1 or not re.search(r'\btype=["\x27]radio["\x27]', matches[0])
                or not re.search(r'\bname=["\x27]pw-' + group + r'["\x27]', matches[0])
                or not re.search(r'<label\b[^>]*\bfor=["\x27]' + control_id + r'["\x27]', source)):
                return False
        proof = qa.get("interactive_gallery") or {}
        disabled = qa.get("images_disabled_320") or {}
        if (proof.get("passed") is not True or proof.get("source_sha256") != qa.get("source_sha256")
            or proof.get("input_ids") != expected_ids or proof.get("inspected_widths") != [680, 375, 320]
            or disabled.get("passed") is not True or disabled.get("source_sha256") != qa.get("source_sha256")
            or disabled.get("native_gallery_captions_visible") is not True):
            return False
        checks = proof.get("checks")
        if not isinstance(checks, list) or [check.get("width") for check in checks if isinstance(check, dict)] != [680, 375, 320]:
            return False
        for check in checks:
            if (check.get("control_ids_checked") != expected_ids
                or any(check.get(field) is not True for field in (
                    "independent_panels", "keyboard_navigation", "keyboard_focus_visible",
                    "static_fallback", "full_gallery_link_visible", "native_captions"))
                or check.get("horizontal_overflow") is not False
                or not isinstance(check.get("minimum_control_height"), (int, float))
                or check["minimum_control_height"] < 44
                or not isinstance(check.get("minimum_control_width"), (int, float))
                or check["minimum_control_width"] < 44):
                return False
    pizza = metadata.get("interactive_pizza")
    if pizza is not None:
        toppings = ["pw-pizza-" + name for name in (
            "sauce", "cheese", "pepperoni", "sausage", "olives", "jalapenos", "pineapple")]
        ids = toppings + ["pw-pizza-slice"]
        if (not isinstance(pizza, dict) or pizza.get("topping_ids") != toppings
            or pizza.get("slice_id") != ids[-1] or pizza.get("static_class") != "pw-pizza-static"
            or pizza.get("builder_variable") != "pizza_builder_url"):
            return False
        inputs = re.findall(r'<input\b[^>]*>', source)
        if len(inputs) != len(ids):
            return False
        for control_id in ids:
            matches = [tag for tag in inputs if re.search(r'\bid=["\x27]' + control_id + r'["\x27]', tag)]
            if (len(matches) != 1 or not re.search(r'\btype=["\x27]checkbox["\x27]', matches[0])
                or len(re.findall(r'<label\b[^>]*\bfor=["\x27]' + control_id + r'["\x27]', source)) != 1):
                return False
        proof = qa.get("interactive_pizza") or {}
        disabled = qa.get("images_disabled_320") or {}
        if (proof.get("passed") is not True or proof.get("source_sha256") != qa.get("source_sha256")
            or proof.get("input_ids") != ids or proof.get("inspected_widths") != [680, 375, 320]
            or proof.get("template_variants") != ["source", "blocks_export"]
            or proof.get("editor_export_interaction") is not True
            or disabled.get("passed") is not True or disabled.get("source_sha256") != qa.get("source_sha256")):
            return False
        checks = proof.get("checks")
        if (not isinstance(checks, list)
            or [(check.get("variant"), check.get("width")) for check in checks if isinstance(check, dict)]
                != [(variant, width) for variant in ("source", "blocks_export") for width in (680, 375, 320)]):
            return False
        for check in checks:
            if (check.get("control_ids_checked") != ids
                or any(check.get(field) is not True for field in (
                    "independent_toppings", "combined_and_mixed_states", "slice_preserves_toppings",
                    "keyboard_navigation", "keyboard_focus_visible", "static_fallback", "builder_link_visible"))
                or check.get("horizontal_overflow") is not False
                or not isinstance(check.get("minimum_control_height"), (int, float))
                or check["minimum_control_height"] < 44
                or not isinstance(check.get("minimum_control_width"), (int, float))
                or check["minimum_control_width"] < 44):
                return False
    links = metadata.get("link_variables", {})
    if not isinstance(links, dict) or any(
        not isinstance(name, str) or not re.fullmatch(r"[a-z][a-z0-9_]*_url", name)
        or name in {"cta_url", "unsubscribe_url"} or not isinstance(label, str) or not label.strip()
        for name, label in links.items()
    ):
        return False
    found = set(re.findall(r'<(?:mj-button|a)\b[^>]*\bhref=["\x27]\{\{\s*([a-z][a-z0-9_]*_url)\s*\}\}["\x27]', source))
    found -= {"cta_url", "unsubscribe_url"}
    editor = qa.get("editor_roundtrip") or {}
    native_required = metadata.get("native_content_review_required", False)
    if not isinstance(native_required, bool):
        return False
    if native_required:
        native_blocks = re.findall(r'<mj-text\b[^>]*>([\s\S]*?)</mj-text>', source)
        structured_blocks = sum(bool(re.search(r'<[a-zA-Z][^>]*>', block)) for block in native_blocks)
        if (editor.get("native_text_blocks_preserved") is not True
            or editor.get("native_html_structure_preserved") is not True
            or editor.get("native_html_attributes_preserved") is not True
            or editor.get("native_text_blocks_checked") != len(native_blocks)
            or editor.get("native_structured_blocks_checked") != structured_blocks):
            return False
    if found != set(links) or qa.get("link_variables", {}) != links:
        return False
    if links and (set(editor.get("selectable_link_variables", [])) != set(links)
                  or editor.get("link_variable_edits_compile") is not True):
        return False
    expected_counts = {
        name: {
            "buttons": len(re.findall(r'<mj-button\b[^>]*\bhref=["\x27]\{\{\s*' + re.escape(name) + r'\s*\}\}["\x27]', source)),
            "native_text_links": len(re.findall(r'<a\b[^>]*\bhref=["\x27]\{\{\s*' + re.escape(name) + r'\s*\}\}["\x27]', source)),
        }
        for name in links
    }
    counts = editor.get("link_variable_edit_counts")
    if (any(value["native_text_links"] for value in expected_counts.values()) or counts is not None):
        if counts != expected_counts:
            return False
    if "<mj-style" in source and not (editor.get("native_styles_preserved") is True
                                     or editor.get("motion_styles_preserved") is True):
        return False
    motion = metadata.get("motion_features", [])
    if not isinstance(motion, list) or qa.get("motion_features", []) != motion:
        return False
    for feature in motion:
        if (not isinstance(feature, dict)
            or not re.fullmatch(r"\.[a-z][a-z0-9-]*(?: img)?", feature.get("selector", ""))
            or feature.get("property") not in {"color", "transform"}
            or not re.fullmatch(r"[a-z][a-z0-9-]*", feature.get("animation", ""))
            or "@keyframes " + feature["animation"] not in source):
            return False
    if motion:
        if editor.get("motion_styles_preserved") is not True:
            return False
        for render in qa.get("renders", []):
            expected = [{**feature, "changed": True, "reduced_motion_disabled": True} for feature in motion]
            checks = render.get("motion_checks")
            if not isinstance(checks, list) or len(checks) != len(expected):
                return False
            for check, required in zip(checks, expected):
                if (not isinstance(check, dict)
                    or any(check.get(key) != value for key, value in required.items())
                    or set(check) - set(required) - {"observation_ms", "cycle_ms"}):
                    return False
                diagnostics = {"observation_ms", "cycle_ms"}.intersection(check)
                if diagnostics:
                    if diagnostics != {"observation_ms", "cycle_ms"}:
                        return False
                    if any(type(check[key]) not in (int, float) or not math.isfinite(check[key]) for key in diagnostics):
                        return False
                    if not 350 <= check["observation_ms"] <= 10150 or check["cycle_ms"] <= 0:
                        return False
    return True
