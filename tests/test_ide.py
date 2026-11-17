import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / file)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


packager = module('ide_package', 'ide/package.py')
manager = module('ide_manage', 'ide/manage.py')
desktop_manager = module('ide_desktop_package', 'manage.py')
publisher = module('ide_release_check', 'tools/publish-release.py')


class IdeTests(unittest.TestCase):
    def test_release_requires_four_consistent_assets_and_rejects_tampered_vsix(self):
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Path(temporary)
            package = json.loads((ROOT / 'plugin.json').read_text())
            version = package['version']
            (fixture / 'ide').mkdir()
            (fixture / 'plugin.json').write_text(json.dumps(package))
            (fixture / 'ide/package.json').write_bytes((ROOT / 'ide/package.json').read_bytes())
            desktop_manager.package(fixture / 'dist' / f'antigrative-dashboard-{version}.zip')
            vsix = packager.build(fixture / 'dist' / f'antigrative-dashboard-ide-{version}.vsix')
            self.assertEqual(len(publisher.checked_assets(fixture, 'v' + version)), 4)
            vsix.write_bytes(vsix.read_bytes() + b'tampered')
            with self.assertRaisesRegex(ValueError, 'IDE package checksum mismatch'):
                publisher.checked_assets(fixture, 'v' + version)

    def test_vsix_contains_complete_runtime_and_install_instructions_without_private_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = packager.build(Path(temporary) / 'ide.vsix')
            with zipfile.ZipFile(output) as archive:
                names = archive.namelist()
                for name in packager.MODULES:
                    self.assertIn('extension/' + name, names)
                self.assertIn('extension/README.md', names)
                package = json.loads(archive.read('extension/package.json'))
                self.assertEqual(package['version'], json.loads((ROOT / 'plugin.json').read_text())['version'])
                self.assertEqual(package['extensionKind'], ['ui'])
                manifest = ET.fromstring(archive.read('extension.vsixmanifest'))
                identity = manifest.find('{*}Metadata/{*}Identity')
                self.assertEqual(identity.get('Version'), package['version'])
                ET.fromstring(archive.read('[Content_Types].xml'))
                self.assertFalse(any('/history-v1/' in n or '/tests/' in n or n.endswith(('.log','.asar','.pyc')) for n in names))
            self.assertEqual(output.with_suffix('.vsix.sha256').read_text().split(),
                             [hashlib.sha256(output.read_bytes()).hexdigest(), output.name])

    def test_missing_runtime_does_not_overwrite_existing_package(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / 'ide.vsix'
            output.write_bytes(b'previous verified bundle')
            with patch.object(packager, 'MODULES', ['ide/missing-module.cjs']):
                with self.assertRaisesRegex(ValueError, 'Missing IDE'):
                    packager.build(output)
            self.assertEqual(output.read_bytes(), b'previous verified bundle')

    def fixture(self, directory, mac=False, identity='antigravity-ide'):
        root = Path(directory)
        executable = root / ('Contents/MacOS/Antigravity IDE' if mac else 'Antigravity IDE.exe')
        app = root / ('Contents/Resources/app' if mac else 'resources/app')
        executable.parent.mkdir(parents=True, exist_ok=True)
        executable.write_bytes(b'fixture')
        (app / 'out').mkdir(parents=True)
        (app / 'out/cli.js').write_text('// fixture')
        (app / 'product.json').write_text(json.dumps({'applicationName': identity}))
        return executable, app

    def test_installer_verifies_host_and_preserves_argument_paths(self):
        for mac in [False, True]:
            with tempfile.TemporaryDirectory(prefix='IDE spaces ') as temporary:
                executable, app = self.fixture(temporary, mac)
                vsix = Path(temporary) / 'extension with spaces.vsix'
                vsix.write_bytes(b'fixture')
                calls = []
                manager.manage('install', executable, vsix, run=lambda args, **kw: calls.append((args, kw)))
                self.assertEqual(calls[0][0], [str(executable.resolve()), str((app / 'out/cli.js').resolve()), '--install-extension', str(vsix.resolve()), '--force'])
                self.assertEqual(calls[0][1]['env']['ELECTRON_RUN_AS_NODE'], '1')
                self.assertTrue(calls[0][1]['check'])

    def test_other_editor_is_rejected_before_install_or_launch(self):
        with tempfile.TemporaryDirectory() as temporary:
            executable, _ = self.fixture(temporary, identity='code')
            with self.assertRaisesRegex(ValueError, 'standalone Antigravity IDE'):
                manager.manage('launch', executable, spawn=lambda *a, **k: self.fail('Wrong editor launched'))

    def test_launch_uses_only_loopback_and_removes_node_mode(self):
        with tempfile.TemporaryDirectory() as temporary:
            executable, _ = self.fixture(temporary)
            calls = []
            with patch.dict('os.environ', {'ELECTRON_RUN_AS_NODE': '1'}):
                manager.manage('launch', executable, workspace=temporary, spawn=lambda args, **kw: calls.append((args, kw)))
            self.assertEqual(calls[0][0][1:3], manager.DEBUG_ARGS)
            self.assertNotIn('ELECTRON_RUN_AS_NODE', calls[0][1]['env'])
            self.assertEqual(calls[0][0][-1], str(Path(temporary).resolve()))

    def test_uninstall_removes_only_the_ide_extension(self):
        with tempfile.TemporaryDirectory() as temporary:
            executable, _ = self.fixture(temporary)
            calls = []
            manager.manage('uninstall', executable, run=lambda args, **kw: calls.append(args))
            self.assertEqual(calls[0][-2:], ['--uninstall-extension', manager.IDENTITY])

    def test_ide_publisher_identity_is_consistent(self):
        package = json.loads((ROOT / 'ide/package.json').read_text(encoding='utf-8'))
        self.assertEqual(package['publisher'], 'shzbz')
        expected_identity = f"{package['publisher']}.{package['name']}"
        self.assertEqual(expected_identity, 'shzbz.antigrative-dashboard-ide')
        self.assertEqual(manager.IDENTITY, expected_identity)
        main_mjs = (ROOT / 'ide/main.mjs').read_text(encoding='utf-8')
        self.assertIn(expected_identity, main_mjs)
        self.assertNotIn('you-should-know-me', main_mjs)

    def test_unpacked_vsix_smoke_imports_all_runtime_entrypoints(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = packager.build(Path(temporary) / 'ide.vsix')
            unpacked = Path(temporary) / 'unpacked'
            with zipfile.ZipFile(output) as archive:
                archive.extractall(unpacked)
            ext_dir = unpacked / 'extension'
            smoke_file = ext_dir / '_smoke_imports.mjs'
            smoke_file.write_text(
                "import { createRequire } from 'node:module';\n"
                "import Module from 'node:module';\n"
                "const origLoad = Module._load;\n"
                "Module._load = function(request, parent, isMain) {\n"
                "  if (request === 'vscode') return {};\n"
                "  return origLoad.apply(this, arguments);\n"
                "};\n"
                "const require = createRequire(import.meta.url);\n"
                "await import('./sidecars/panel/store.mjs');\n"
                "await import('./sidecars/panel/usage.mjs');\n"
                "await import('./ide/client.mjs');\n"
                "await import('./ide/runtime.mjs');\n"
                "process.argv.push('--exe', process.execPath);\n"
                "await import('./ide/launch.mjs');\n"
                "require('./ide/extension.cjs');\n",
                encoding='utf-8',
            )
            imported = subprocess.run(
                ['node', str(smoke_file)],
                cwd=ext_dir,
                capture_output=True,
                text=True,
            )
            self.assertEqual(imported.returncode, 0, imported.stderr or imported.stdout)

            env = dict(os.environ)
            env['AG_PULSE_IDE_PROFILE'] = ''
            main_run = subprocess.run(
                ['node', 'ide/main.mjs'],
                cwd=ext_dir,
                env=env,
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(main_run.returncode, 0)
            combined = (main_run.stderr or '') + (main_run.stdout or '')
            self.assertNotIn('ERR_MODULE_NOT_FOUND', combined)
            self.assertIn('IDE profile is required', combined)

    def test_release_require_native_enforces_tagged_binaries_in_zip_and_vsix(self):
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Path(temporary)
            package = json.loads((ROOT / 'plugin.json').read_text(encoding='utf-8'))
            version = package['version']
            (fixture / 'ide').mkdir()
            (fixture / 'plugin.json').write_text(json.dumps(package), encoding='utf-8')
            (fixture / 'ide/package.json').write_bytes((ROOT / 'ide/package.json').read_bytes())

            staged = []
            try:
                for rel in packager.RELEASE_NATIVE_ADDONS + list(desktop_manager.RELEASE_NATIVE_CLI_BINS):
                    target = ROOT / rel
                    if not target.exists():
                        target.parent.mkdir(parents=True, exist_ok=True)
                        target.write_bytes(b'native-fixture')
                        staged.append(target)

                zip_path = fixture / 'dist' / f'antigrative-dashboard-{version}.zip'
                desktop_manager.package(
                    zip_path,
                    require_native=True,
                )
                vsix = packager.build(
                    fixture / 'dist' / f'antigrative-dashboard-ide-{version}.vsix',
                    require_native=True,
                )
                self.assertEqual(len(publisher.checked_assets(fixture, 'v' + version, require_native=True)), 4)

                with zipfile.ZipFile(zip_path) as zf:
                    info = zf.getinfo('antigrative-dashboard/cli/bin/ag-pulse-statusline.linux-x64')
                    self.assertEqual((info.external_attr >> 16) & 0o777, 0o755)
                with zipfile.ZipFile(vsix) as vf:
                    self.assertIn('Extension="node"', vf.read('[Content_Types].xml').decode('utf-8'))
            finally:
                for target in staged:
                    target.unlink(missing_ok=True)
