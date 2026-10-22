import assert from "node:assert/strict";
import test from "node:test";
import { passwordStrength } from "../src/lib/ui/password-strength.ts";

test("strength rewards length first and character variety at moderate lengths", () => {
	for (const password of ["", "short", "elevenchars", "Ab1!Ab1!Ab1"]) {
		assert.equal(passwordStrength(password), "weak", password);
	}
	for (const password of ["twelvechars!", "lowercaseonly", "UPPER123ABCD"]) {
		assert.equal(passwordStrength(password), "fair", password);
	}
	for (const password of [
		"Twelve1chars",
		"correct horse battery",
		"sixteencharacter",
		"ñandú pingüino ü",
	]) {
		assert.equal(passwordStrength(password), "good", password);
	}
});
