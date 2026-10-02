import importlib.util
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest


spec = importlib.util.spec_from_file_location("sync_skills", Path(__file__).parents[1] / "sync-skills.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
sync_skills = module.sync_skills


class SkillSyncTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "skills"
        self.target = self.root / ".agents" / "skills"
        self.skill = self.source / "oncewise-flow"
        self.skill.mkdir(parents=True)
        (self.skill / "SKILL.md").write_text("current source", encoding="utf-8")

    def test_sync_includes_references_and_only_source_controls_installed_content(self):
        references = self.skill / "references"
        references.mkdir()
        (references / "format.md").write_text("format", encoding="utf-8")
        source_before = (self.skill / "SKILL.md").read_bytes()
        sync_skills(self.source, self.target)
        installed = self.target / "oncewise-flow"
        self.assertEqual((installed / "references" / "format.md").read_text(), "format")
        (installed / "SKILL.md").write_text("local edit", encoding="utf-8")
        sync_skills(self.source, self.target)
        self.assertEqual((installed / "SKILL.md").read_bytes(), source_before)
        self.assertEqual((self.skill / "SKILL.md").read_bytes(), source_before)
        self.assertEqual(sync_skills(self.source, self.target), [])

    def test_check_detects_drift_without_creating_or_changing_target(self):
        self.assertTrue(sync_skills(self.source, self.target, check=True))
        self.assertFalse(self.target.exists())
        sync_skills(self.source, self.target)
        installed_file = self.target / "oncewise-flow" / "SKILL.md"
        installed_file.write_text("old installation", encoding="utf-8")
        self.assertTrue(sync_skills(self.source, self.target, check=True))
        self.assertEqual(installed_file.read_text(), "old installation")

    def test_removes_obsolete_managed_files_but_preserves_other_installed_skills(self):
        sync_skills(self.source, self.target)
        obsolete = self.target / "oncewise-flow" / "old" / "nested"
        obsolete.mkdir(parents=True)
        (obsolete / "reference.md").write_text("stale", encoding="utf-8")
        unrelated = self.target / "another-skill"
        unrelated.mkdir()
        (unrelated / "SKILL.md").write_text("keep", encoding="utf-8")
        sync_skills(self.source, self.target)
        self.assertFalse((self.target / "oncewise-flow" / "old").exists())
        self.assertEqual((unrelated / "SKILL.md").read_text(), "keep")

    def test_source_file_and_directory_replacements_are_mirrored(self):
        (self.skill / "reference").write_text("file", encoding="utf-8")
        sync_skills(self.source, self.target)
        (self.skill / "reference").unlink()
        (self.skill / "reference").mkdir()
        (self.skill / "reference" / "format.md").write_text("nested", encoding="utf-8")
        sync_skills(self.source, self.target)
        self.assertEqual((self.target / "oncewise-flow" / "reference" / "format.md").read_text(), "nested")
        (self.skill / "reference" / "format.md").unlink()
        (self.skill / "reference").rmdir()
        (self.skill / "reference").write_text("file again", encoding="utf-8")
        sync_skills(self.source, self.target)
        self.assertEqual((self.target / "oncewise-flow" / "reference").read_text(), "file again")

    def test_empty_source_and_overlapping_roots_refuse_mutation(self):
        with self.assertRaises(ValueError):
            sync_skills(self.source, self.source)
        with self.assertRaises(ValueError):
            sync_skills(self.source, self.source / "installed")
        (self.skill / "SKILL.md").unlink()
        with self.assertRaises(ValueError):
            sync_skills(self.source, self.target)
        self.assertFalse(self.target.exists())

    def test_linked_target_is_refused_without_changing_source(self):
        self.target.parent.mkdir(parents=True)
        try:
            self.target.symlink_to(self.source, target_is_directory=True)
        except OSError:
            self.skipTest("Directory symlinks unavailable on this platform")
        with self.assertRaises(ValueError):
            sync_skills(self.source, self.target)
        self.assertEqual((self.skill / "SKILL.md").read_text(), "current source")

    def test_watch_tracks_source_changes_when_launched_outside_repository(self):
        scripts = self.root / "scripts"
        scripts.mkdir()
        script = scripts / "sync-skills.py"
        shutil.copyfile(spec.origin, script)
        process = subprocess.Popen(
            [sys.executable, str(script), "--watch"],
            cwd=self.root.parent,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        try:
            installed_file = self.target / "oncewise-flow" / "SKILL.md"

            def wait_for_content(expected):
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline:
                    if installed_file.exists() and installed_file.read_text() == expected:
                        return
                    if process.poll() is not None:
                        self.fail(process.stderr.read().decode())
                    time.sleep(0.05)
                self.fail(f"Watcher did not install {expected!r}")

            wait_for_content("current source")
            (self.skill / "SKILL.md").write_text("updated source", encoding="utf-8")
            wait_for_content("updated source")
        finally:
            process.terminate()
            process.wait(timeout=5)
            process.stderr.close()


if __name__ == "__main__":
    unittest.main()
