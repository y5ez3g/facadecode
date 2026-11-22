import unittest
from pathlib import Path
from unittest.mock import patch

import inventory_extension


ROOT = Path(__file__).resolve().parent.parent
UI = inventory_extension.UI
RUST_NEW_AGENT = "extension/vscode-rust/command/facade.newAgent"
NEW_AGENT_REGISTRATION = "vscode.commands.registerCommand(COMMANDS.newAgent, () => pickers.newAgent())"


class ExtensionCommandInventoryTests(unittest.TestCase):
    def mutate_registration(self, replacement):
        read = inventory_extension._read

        def changed(root, path):
            source = read(root, path)
            if path == UI:
                self.assertEqual(source.count(NEW_AGENT_REGISTRATION), 1)
                return source.replace(NEW_AGENT_REGISTRATION, replacement)
            return source

        return patch.object(inventory_extension, "_read", side_effect=changed)

    def test_whitespace_preserves_rust_registration_of_shared_command(self):
        expected = inventory_extension.discover(ROOT)
        with self.mutate_registration(NEW_AGENT_REGISTRATION.replace("(", "( ", 1)):
            actual = inventory_extension.discover(ROOT)
        self.assertEqual(actual[RUST_NEW_AGENT], UI)
        self.assertEqual(actual, expected)

    def test_literal_bracket_member_preserves_rust_registration(self):
        expected = inventory_extension.discover(ROOT)
        for member in ("['registerCommand']", '[ "registerCommand" ]'):
            with self.subTest(member=member), self.mutate_registration(
                NEW_AGENT_REGISTRATION.replace(".registerCommand", member)
            ):
                actual = inventory_extension.discover(ROOT)
                self.assertEqual(actual[RUST_NEW_AGENT], UI)
                self.assertEqual(actual, expected)

    def test_unfamiliar_serving_registration_is_rejected(self):
        changed = NEW_AGENT_REGISTRATION.replace("COMMANDS.newAgent", "commandForNewAgent()")
        with self.mutate_registration(changed):
            with self.assertRaisesRegex(
                ValueError, r"ui/commands/index\.ts: unrecognized rust serving command registration .*commandForNewAgent"
            ):
                inventory_extension.discover(ROOT)


if __name__ == "__main__":
    unittest.main()
