#!/usr/bin/env python3
"""Release gates for the original editable catalogue drafts."""

import importlib.util
import json
import shutil
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("build-template-enhancement-release.py")
spec = importlib.util.spec_from_file_location("template_enhancement_release", SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ReleaseTest(unittest.TestCase):
    def test_native_pizza_requires_all_states_and_blocks_export_evidence(self):
        catalog_id = "rge:cowabunga-dude"
        source_dir = module.BASE / "items" / catalog_id.replace(":", "-")
        files = module.item_files(source_dir, self.worklist[catalog_id])
        self.assertEqual(len(files["images"]), 2)  # previews only; native artwork
        entry = {"catalog_id": catalog_id, "mjml_sha256": files["qa"]["source_sha256"]}
        hosted, review = self.release_inputs(files, entry)
        result = module.release_item(entry, self.worklist, files, hosted, review)
        self.assertEqual(result["design_metadata"]["interactive_pizza"], files["metadata"]["interactive_pizza"])
        self.assertIn('for="pw-pizza-slice"', result["body_mjml"])
        self.assertIn("#pw-pizza-olives:checked", result["body_mjml"])
        with tempfile.TemporaryDirectory(dir=module.BASE) as temporary:
            directory = Path(temporary) / source_dir.name
            shutil.copytree(source_dir, directory)
            for field, value in [
                ("independent_toppings", False), ("combined_and_mixed_states", False),
                ("slice_preserves_toppings", False), ("keyboard_navigation", False),
                ("keyboard_focus_visible", False), ("static_fallback", False),
                ("builder_link_visible", False), ("minimum_control_height", 43),
                ("control_ids_checked", ["pw-pizza-sauce"]),
            ]:
                with self.subTest(field=field):
                    qa = json.loads(json.dumps(files["qa"]))
                    qa["interactive_pizza"]["checks"][5][field] = value
                    (directory / "qa.json").write_text(json.dumps(qa))
                    with self.assertRaisesRegex(ValueError, "Named action or motion"):
                        module.item_files(directory, self.worklist[catalog_id])
            qa = json.loads(json.dumps(files["qa"]))
            qa["interactive_pizza"]["editor_export_interaction"] = False
            (directory / "qa.json").write_text(json.dumps(qa))
            with self.assertRaisesRegex(ValueError, "Named action or motion"):
                module.item_files(directory, self.worklist[catalog_id])

    def test_native_gallery_reuses_originals_and_requires_interaction_evidence(self):
        catalog_id = "rge:fashion-special-try-our-street-style-flip-book"
        source_dir = module.BASE / "items" / catalog_id.replace(":", "-")
        files = module.item_files(source_dir, self.worklist[catalog_id])
        self.assertEqual(len(files["images"]), 8)  # six originals and two previews
        self.assertEqual(files["qa"]["editor_roundtrip"]["selectable_image_blocks"], 24)
        entry = {"catalog_id": catalog_id, "mjml_sha256": files["qa"]["source_sha256"]}
        hosted, review = self.release_inputs(files, entry)
        result = module.release_item(entry, self.worklist, files, hosted, review)
        for key, count in files["metadata"]["image_reference_counts"].items():
            self.assertEqual(count, 4)
            self.assertEqual(result["body_mjml"].count(hosted[key]["url"]), 4)
            self.assertEqual(result["design_metadata"]["image_asset_urls"][key], hosted[key]["url"])
        self.assertIn('for="pw-bottom-6"', result["body_mjml"])
        self.assertIn("body:not(.pw-static):has(#pw-top-4:checked)", result["body_mjml"])
        with tempfile.TemporaryDirectory(dir=module.BASE) as temporary:
            directory = Path(temporary) / source_dir.name
            shutil.copytree(source_dir, directory)
            for field, value in [
                ("independent_panels", False), ("keyboard_navigation", False),
                ("keyboard_focus_visible", False), ("static_fallback", False),
                ("native_captions", False),
                ("full_gallery_link_visible", False), ("minimum_control_width", 43),
                ("control_ids_checked", ["pw-top-1"]),
            ]:
                with self.subTest(field=field):
                    qa = json.loads(json.dumps(files["qa"]))
                    qa["interactive_gallery"]["checks"][2][field] = value
                    (directory / "qa.json").write_text(json.dumps(qa))
                    with self.assertRaisesRegex(ValueError, "Named action or motion"):
                        module.item_files(directory, self.worklist[catalog_id])
            for target in ("image_reference_counts", "image_reference_edit_counts"):
                qa = json.loads(json.dumps(files["qa"]))
                container = qa if target == "image_reference_counts" else qa["editor_roundtrip"]
                container[target]["hero"] = 3
                (directory / "qa.json").write_text(json.dumps(qa))
                with self.assertRaisesRegex(ValueError, "Named action or motion"):
                    module.item_files(directory, self.worklist[catalog_id])

    def test_native_diagrams_require_full_content_and_attribute_preservation(self):
        catalog_id = "rge:the-digital-designer-of-the-future"
        source_dir = module.BASE / "items" / catalog_id.replace(":", "-")
        original = module.item_files(source_dir, self.worklist[catalog_id])
        self.assertTrue(original["metadata"]["native_content_review_required"])
        self.assertEqual(original["qa"]["editor_roundtrip"]["native_text_blocks_checked"], 36)
        self.assertIn("A LITTLE TIME NOTEBOOK", original["mjml"])
        with tempfile.TemporaryDirectory(dir=module.BASE) as temporary:
            directory = Path(temporary) / source_dir.name
            shutil.copytree(source_dir, directory)
            for field, value in [
                ("native_text_blocks_preserved", False),
                ("native_html_structure_preserved", False),
                ("native_html_attributes_preserved", False),
                ("native_text_blocks_checked", 35),
                ("native_structured_blocks_checked", 16),
            ]:
                with self.subTest(field=field):
                    qa = json.loads(json.dumps(original["qa"]))
                    qa["editor_roundtrip"][field] = value
                    (directory / "qa.json").write_text(json.dumps(qa))
                    with self.assertRaisesRegex(ValueError, "Named action or motion"):
                        module.item_files(directory, self.worklist[catalog_id])

    def test_native_article_links_survive_release_and_require_all_occurrences(self):
        catalog_id = "rge:check-out-what-s-new-this-month-on-think-with-google"
        source_dir = module.BASE / "items" / catalog_id.replace(":", "-")
        files = module.item_files(source_dir, self.worklist[catalog_id])
        entry = {"catalog_id": catalog_id, "mjml_sha256": files["qa"]["source_sha256"]}
        hosted, review = self.release_inputs(files, entry)
        result = module.release_item(entry, self.worklist, files, hosted, review)
        declared = files["metadata"]["link_variables"]
        self.assertEqual(len(declared), 13)
        self.assertTrue(set(declared).issubset({field["name"] for field in result["variables"]}))
        self.assertIn('href="{{ read_reader_url }}"', result["body_mjml"])
        self.assertGreater(files["qa"]["editor_roundtrip"]["link_variable_edit_counts"]["share_email_url"]["native_text_links"], 1)
        with tempfile.TemporaryDirectory(dir=module.BASE) as temporary:
            directory = Path(temporary) / source_dir.name
            shutil.copytree(source_dir, directory)
            qa_path = directory / "qa.json"
            qa = json.loads(qa_path.read_text())
            qa["editor_roundtrip"]["link_variable_edit_counts"]["share_email_url"]["native_text_links"] -= 1
            qa_path.write_text(json.dumps(qa))
            with self.assertRaisesRegex(ValueError, "Named action or motion"):
                module.item_files(directory, self.worklist[catalog_id])

    def test_responsive_gallery_requires_preserved_native_styles(self):
        catalog_id = "rge:ginetta-logbook-august-2016"
        source_dir = module.BASE / "items" / catalog_id.replace(":", "-")
        module.item_files(source_dir, self.worklist[catalog_id])
        with tempfile.TemporaryDirectory(dir=module.BASE) as temporary:
            directory = Path(temporary) / source_dir.name
            shutil.copytree(source_dir, directory)
            qa_path = directory / "qa.json"
            qa = json.loads(qa_path.read_text())
            qa["editor_roundtrip"]["native_styles_preserved"] = False
            qa_path.write_text(json.dumps(qa))
            with self.assertRaisesRegex(ValueError, "Named action or motion"):
                module.item_files(directory, self.worklist[catalog_id])

    def test_named_voting_links_survive_release_and_require_editor_evidence(self):
        catalog_id = "rge:because-you-cant-spell-focus-without-us"
        source_dir = module.BASE / "items" / catalog_id.replace(":", "-")
        files = module.item_files(source_dir, self.worklist[catalog_id])
        entry = {"catalog_id": catalog_id, "mjml_sha256": files["qa"]["source_sha256"]}
        hosted, review = self.release_inputs(files, entry)
        result = module.release_item(entry, self.worklist, files, hosted, review)
        declared = files["metadata"]["link_variables"]
        self.assertEqual(len(declared), 4)
        self.assertTrue(set(declared).issubset({field["name"] for field in result["variables"]}))
        for name in declared:
            self.assertIn('{{ ' + name + ' }}', result["body_mjml"])
        with tempfile.TemporaryDirectory(dir=module.BASE) as temporary:
            directory = Path(temporary) / source_dir.name
            shutil.copytree(source_dir, directory)
            qa_path = directory / "qa.json"
            qa = json.loads(qa_path.read_text())
            qa["editor_roundtrip"]["selectable_link_variables"].pop()
            qa_path.write_text(json.dumps(qa))
            with self.assertRaisesRegex(ValueError, "Named action or motion"):
                module.item_files(directory, self.worklist[catalog_id])

    def test_motion_requires_preserved_styles_and_reduced_motion_checks(self):
        catalog_id = "rge:the-ux-reader"
        source_dir = module.BASE / "items" / catalog_id.replace(":", "-")
        original = module.item_files(source_dir, self.worklist[catalog_id])
        self.assertEqual(len(original["metadata"]["motion_features"]), 2)
        with tempfile.TemporaryDirectory(dir=module.BASE) as temporary:
            directory = Path(temporary) / source_dir.name
            shutil.copytree(source_dir, directory)
            qa_path = directory / "qa.json"
            for invalidate in ["editor", "reduced_motion"]:
                qa = json.loads(json.dumps(original["qa"]))
                if invalidate == "editor":
                    qa["editor_roundtrip"]["motion_styles_preserved"] = False
                else:
                    qa["renders"][0]["motion_checks"][0]["reduced_motion_disabled"] = False
                qa_path.write_text(json.dumps(qa))
                with self.assertRaisesRegex(ValueError, "Named action or motion"):
                    module.item_files(directory, self.worklist[catalog_id])

    def test_slow_blink_observations_keep_motion_evidence_required(self):
        from template_enhancement_capabilities import extended_evidence_ready
        catalog_id = "rge:when-to-drop-everything-for-personal-work-how-to-turn-a-digital-font-into-wood-behind-those-sva-underground-posters-more"
        directory = module.BASE / "items" / catalog_id.replace(":", "-")
        files = module.item_files(directory, self.worklist[catalog_id])
        source = (directory / "template.mjml").read_text()
        metadata, original = files["metadata"], files["qa"]
        self.assertEqual(original["renders"][0]["motion_checks"][0]["cycle_ms"], 6000)
        legacy = json.loads(json.dumps(original))
        for render in legacy["renders"]:
            for check in render["motion_checks"]:
                check.pop("observation_ms")
                check.pop("cycle_ms")
        self.assertTrue(extended_evidence_ready(source, metadata, legacy))
        for field, value in [
            ("changed", False), ("reduced_motion_disabled", False),
            ("observation_ms", 0), ("observation_ms", 10151),
            ("observation_ms", True), ("cycle_ms", 0),
            ("cycle_ms", float("nan")), ("unexpected", True),
        ]:
            with self.subTest(field=field, value=value):
                qa = json.loads(json.dumps(original))
                qa["renders"][0]["motion_checks"][0][field] = value
                self.assertFalse(extended_evidence_ready(source, metadata, qa))
        incomplete = json.loads(json.dumps(original))
        incomplete["renders"][0]["motion_checks"][0].pop("cycle_ms")
        self.assertFalse(extended_evidence_ready(source, metadata, incomplete))

    @classmethod
    def setUpClass(cls):
        cls.worklist = module.read_worklist(module.BASE / "worklist.jsonl")
        cls.catalog_id = "aura:html:29679"
        cls.record = cls.worklist[cls.catalog_id]
        cls.files = module.item_files(module.BASE / "items/aura-html-29679", cls.record)
        cls.entry = {
            "catalog_id": cls.catalog_id,
            "mjml_sha256": cls.files["qa"]["source_sha256"],
        }

    def release_inputs(self, files=None, entry=None):
        files = self.files if files is None else files
        entry = self.entry if entry is None else entry
        hosted = {
            variant: {"url": f"https://assets.postwave.test/{variant}.png", "sha256": image["sha256"]}
            for variant, image in files["images"].items()
        }
        review = {
            "reviewer": "Catalogue reviewer",
            "reviewed_at": "2026-01-01T00:00:00Z",
            "mjml_sha256": entry["mjml_sha256"],
            **{f"{variant}_sha256": image["sha256"] for variant, image in files["images"].items()},
            "checks": {check: True for check in module.REVIEW_CHECKS},
        }
        return hosted, review

    def test_native_text_release_keeps_preview_and_review_requirements(self):
        catalog_id = "rge:mailchimp-ux-issue-23-plain-wrong"
        files = module.item_files(module.BASE / "items" / catalog_id.replace(":", "-"), self.worklist[catalog_id])
        entry = {"catalog_id": catalog_id, "mjml_sha256": files["qa"]["source_sha256"]}
        hosted, review = self.release_inputs(files, entry)
        result = module.release_item(entry, self.worklist, files, hosted, review)
        self.assertEqual(set(result["design_metadata"]["asset_digests"]), {"desktop", "mobile"})
        self.assertEqual(result["design_metadata"]["visual_mode"], "native_text")
        self.assertEqual(result["generation_metadata"]["image_source"], "native_text")
        self.assertIn("<pre", result["body_mjml"])
        self.assertNotIn("<mj-image", result["body_mjml"])
        self.assertEqual(result["source_metadata"]["inspired_by"]["catalog_id"], catalog_id)
        self.assertIn("{{ mailing_address }}", result["body_mjml"])
        mobile = hosted.pop("mobile")
        with self.assertRaisesRegex(ValueError, "Hosted mobile digest"):
            module.release_item(entry, self.worklist, files, hosted, review)
        hosted["mobile"] = mobile
        review["checks"]["email_clients"] = False
        with self.assertRaisesRegex(ValueError, "review checks"):
            module.release_item(entry, self.worklist, files, hosted, review)

    def test_native_text_inventory_rejects_hidden_images_and_inconsistent_qa(self):
        catalog_id = "rge:mailchimp-ux-issue-23-plain-wrong"
        source_dir = module.BASE / "items" / catalog_id.replace(":", "-")
        # Keep temporary files beneath ROOT so the real path checks also run.
        with tempfile.TemporaryDirectory(dir=module.BASE) as temporary:
            directory = Path(temporary) / source_dir.name
            shutil.copytree(source_dir, directory)
            source = (directory / "template.mjml").read_text(encoding="utf-8")
            qa = module.read_json(directory / "qa.json")
            for markup in ('<img src="https://assets.postwave.test/hidden.png">',
                           '<mj-section background-url="https://assets.postwave.test/hidden.png"></mj-section>'):
                with self.subTest(markup=markup):
                    changed = source.replace("</mj-body>", markup + "</mj-body>")
                    (directory / "template.mjml").write_text(changed, encoding="utf-8")
                    qa["source_sha256"] = module.digest(changed.encode("utf-8"))
                    (directory / "qa.json").write_text(json.dumps(qa), encoding="utf-8")
                    with self.assertRaisesRegex(ValueError, "image (evidence|markup).*inconsistent"):
                        module.item_files(directory, self.worklist[catalog_id])
            (directory / "template.mjml").write_text(source, encoding="utf-8")
            qa["source_sha256"] = module.digest(source.encode("utf-8"))
            qa["renders"][0]["image_count"] = 1
            (directory / "qa.json").write_text(json.dumps(qa), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "Native text image evidence"):
                module.item_files(directory, self.worklist[catalog_id])

    def test_release_is_editable_and_keeps_source_provenance(self):
        hosted, review = self.release_inputs()
        result = module.release_item(self.entry, self.worklist, self.files, hosted, review)
        self.assertEqual(result["template_kind"], "editable")
        self.assertEqual(result["source_provider"], "postwave")
        self.assertEqual(result["source_metadata"]["inspired_by"]["catalog_id"], self.catalog_id)
        self.assertTrue(result["design_metadata"]["has_desktop_preview"])
        self.assertTrue(result["design_metadata"]["has_mobile_preview"])
        self.assertIn("https://assets.postwave.test/hero.png", result["body_mjml"])
        self.assertIn("{{ cta_url }}", result["body_mjml"])
        self.assertIn("{{ mailing_address }}", result["body_mjml"])
        self.assertNotIn("__HERO_IMAGE_URL__", result["body_mjml"])
        self.assertNotIn("__CTA_URL__", result["body_mjml"])
        self.assertEqual({item["name"] for item in result["variables"]}, {"cta_url", "mailing_address"})

    def test_background_images_keep_editable_sections_and_asset_evidence(self):
        catalog_id = "rge:5-things-we-ve-learned-in-5-years"
        files = module.item_files(module.BASE / "items" / catalog_id.replace(":", "-"), self.worklist[catalog_id])
        entry = {"catalog_id": catalog_id, "mjml_sha256": files["qa"]["source_sha256"]}
        hosted, review = self.release_inputs(files, entry)
        result = module.release_item(entry, self.worklist, files, hosted, review)
        self.assertEqual(result["design_metadata"]["background_image_keys"], ["hero", "confetti"])
        self.assertIn('background-url="https://assets.postwave.test/hero.png"', result["body_mjml"])
        self.assertIn('background-url="https://assets.postwave.test/confetti.png"', result["body_mjml"])
        self.assertIn("<h1", result["body_mjml"])
        self.assertEqual(set(result["design_metadata"]["asset_digests"]), set(files["images"]))
        hosted.pop("confetti")
        with self.assertRaisesRegex(ValueError, "Hosted confetti digest"):
            module.release_item(entry, self.worklist, files, hosted, review)

    def test_background_inventory_rejects_stale_render_and_editor_evidence(self):
        catalog_id = "rge:5-things-we-ve-learned-in-5-years"
        source_dir = module.BASE / "items" / catalog_id.replace(":", "-")
        with tempfile.TemporaryDirectory(dir=module.BASE) as temporary:
            directory = Path(temporary) / source_dir.name
            shutil.copytree(source_dir, directory)
            original = module.read_json(directory / "qa.json")
            for kind in ("render_count", "editor_count", "editor_compile", "background_metadata"):
                with self.subTest(kind=kind):
                    qa = json.loads(json.dumps(original))
                    if kind == "render_count":
                        qa["renders"][0]["background_image_count"] = 0
                    elif kind == "editor_count":
                        qa["editor_roundtrip"]["selectable_background_blocks"] = 0
                    elif kind == "editor_compile":
                        qa["editor_roundtrip"]["background_edits_compile"] = False
                    else:
                        qa["background_image_keys"] = []
                    (directory / "qa.json").write_text(json.dumps(qa), encoding="utf-8")
                    with self.assertRaisesRegex(ValueError, "(?i)image (editing |markup |evidence).*inconsistent"):
                        module.item_files(directory, self.worklist[catalog_id])

    def test_release_rejects_stale_preview_and_missing_review(self):
        hosted, review = self.release_inputs()
        review["mobile_sha256"] = "sha256:stale"
        with self.assertRaisesRegex(ValueError, "mobile preview"):
            module.release_item(self.entry, self.worklist, self.files, hosted, review)
        review["mobile_sha256"] = self.files["images"]["mobile"]["sha256"]
        review["checks"]["rights"] = False
        with self.assertRaisesRegex(ValueError, "review checks"):
            module.release_item(self.entry, self.worklist, self.files, hosted, review)

    def test_release_rejects_placeholder_asset_host(self):
        hosted, review = self.release_inputs()
        hosted["hero"]["url"] = "https://example.invalid/image.png"
        with self.assertRaisesRegex(ValueError, "placeholder host"):
            module.release_item(self.entry, self.worklist, self.files, hosted, review)

    def test_french_venue_footer_keeps_the_editable_mailing_address(self):
        catalog_id = "rge:decouverte-de-lannee-un-chateau-ideal-pour"
        files = module.item_files(
            module.BASE / "items/rge-decouverte-de-lannee-un-chateau-ideal-pour",
            self.worklist[catalog_id],
        )
        entry = {"catalog_id": catalog_id, "mjml_sha256": files["qa"]["source_sha256"]}
        hosted = {
            variant: {"url": f"https://assets.postwave.test/{variant}.png", "sha256": image["sha256"]}
            for variant, image in files["images"].items()
        }
        review = {
            "reviewer": "Catalogue reviewer",
            "reviewed_at": "2026-01-01T00:00:00Z",
            "mjml_sha256": entry["mjml_sha256"],
            **{f"{variant}_sha256": image["sha256"] for variant, image in files["images"].items()},
            "checks": {check: True for check in module.REVIEW_CHECKS},
        }
        result = module.release_item(entry, self.worklist, files, hosted, review)
        self.assertIn("{{ mailing_address }}", result["body_mjml"])
        self.assertNotIn("Ajoutez votre adresse postale avant l'envoi", result["body_mjml"])
        self.assertIn("https://assets.postwave.test/salon.png", result["body_mjml"])
        self.assertIn("https://assets.postwave.test/garden.png", result["body_mjml"])
        self.assertNotIn("__IMAGE_SALON_URL__", result["body_mjml"])
        self.assertEqual(set(result["design_metadata"]["asset_digests"]), set(files["images"]))
        garden = hosted.pop("garden")
        with self.assertRaisesRegex(ValueError, "Hosted garden digest"):
            module.release_item(entry, self.worklist, files, hosted, review)
        hosted["garden"] = garden
        review.pop("salon_sha256")
        with self.assertRaisesRegex(ValueError, "salon image"):
            module.release_item(entry, self.worklist, files, hosted, review)


if __name__ == "__main__":
    unittest.main()
