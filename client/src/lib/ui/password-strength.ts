export type PasswordStrength = "weak" | "fair" | "good";

/** Rough guidance for a password that protects a seed against offline guessing. */
export function passwordStrength(password: string): PasswordStrength {
	const length = [...password].length;
	if (length < 12) {
		return "weak";
	}
	if (length >= 16) {
		return "good";
	}
	const classes = [/\p{Ll}/u, /\p{Lu}/u, /\p{N}/u, /[^\p{Ll}\p{Lu}\p{N}]/u];
	return classes.filter((pattern) => pattern.test(password)).length >= 3
		? "good"
		: "fair";
}
