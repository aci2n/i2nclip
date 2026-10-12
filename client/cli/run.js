import { basename } from "node:path";
import { parseArgs } from "node:util";
import * as library from "../src/lib/index.js";
import {
	passwordFromFile,
	promptPassword,
	readFileBounded,
	recoveryPath,
	saveRecovery,
	writeExclusive,
} from "./io.js";

export class UsageError extends Error {}

export const HELP = `Usage: i2nclip COMMAND [options]

create --server URL --otc CODE       Create and register a library
register --otc CODE                  Retry registration of a saved library
list [--tags TEXT] [--after CURSOR]   List/search one page (JSON items and next)
upload FILE [--tags TEXT] [--content-type TYPE]
download ID --output PATH            Download without overwriting
delete ID                           Delete one item
tags ID --tags TEXT                  Replace tags (empty TEXT clears)
tags ID [--add TEXT] [--remove TEXT]  Remove, then add tags; repeatable options

--recovery FILE       Override $XDG_CONFIG_HOME/i2nclip/recovery.json
                      (default: ~/.config/i2nclip/recovery.json)
--password-file PATH  Read password from a file, or /dev/stdin
--authorize-with FILE Authorize create/register using an existing recovery file
--authorizer-password-file PATH  Password for that authorizing library
--help                Show this help

Passwords are prompted without echo. Copy an extension recovery file to the
configuration path, or supply --recovery. Upload accepts exactly one file.
`;

const commandOptions = {
	create: ["server", "otc", "authorize-with", "authorizer-password-file"],
	register: ["otc", "authorize-with", "authorizer-password-file"],
	list: ["tags", "after"],
	upload: ["tags", "content-type"],
	download: ["output"],
	delete: [],
	tags: ["tags", "add", "remove"],
};
const strings = [
	"server",
	"otc",
	"authorize-with",
	"authorizer-password-file",
	"tags",
	"after",
	"content-type",
	"output",
	"recovery",
	"password-file",
];

function parse(argv) {
	let parsed;
	try {
		parsed = parseArgs({
			args: argv,
			allowPositionals: true,
			options: {
				...Object.fromEntries(
					strings.map((name) => [name, { type: "string" }]),
				),
				add: { type: "string", multiple: true },
				remove: { type: "string", multiple: true },
				help: { type: "boolean", short: "h" },
			},
		});
	} catch (error) {
		throw new UsageError(error.message);
	}
	const { values, positionals } = parsed;
	if (values.help) {
		return { help: true };
	}
	const [command, ...args] = positionals;
	if (!Object.hasOwn(commandOptions, command ?? "")) {
		throw new UsageError("Choose a command; use --help for usage.");
	}
	const allowed = [...commandOptions[command], "recovery", "password-file"];
	for (const option of Object.keys(values)) {
		if (!allowed.includes(option)) {
			throw new UsageError(`--${option} is not supported by ${command}.`);
		}
	}
	const count = ["upload", "download", "delete", "tags"].includes(command)
		? 1
		: 0;
	if (args.length !== count) {
		throw new UsageError(
			`${command} requires ${count === 1 ? "exactly one argument" : "no positional arguments"}.`,
		);
	}
	for (const option of command === "create"
		? ["server"]
		: command === "register"
			? []
			: command === "download"
				? ["output"]
				: []) {
		if (!values[option]?.trim()) {
			throw new UsageError(`--${option} is required.`);
		}
	}
	if (["create", "register"].includes(command)) {
		if (
			Boolean(values.otc?.trim()) === Boolean(values["authorize-with"]?.trim())
		) {
			throw new UsageError("Choose exactly one of --otc or --authorize-with.");
		}
		if (values["authorizer-password-file"] && !values["authorize-with"]) {
			throw new UsageError(
				"--authorizer-password-file requires --authorize-with.",
			);
		}
	}
	for (const option of [
		"recovery",
		"password-file",
		"after",
		"content-type",
		"authorize-with",
		"authorizer-password-file",
	]) {
		if (values[option] !== undefined && !values[option].trim()) {
			throw new UsageError(`--${option} must not be empty.`);
		}
	}
	if (
		["download", "delete", "tags"].includes(command) &&
		!/^[a-f0-9]{64}$/.test(args[0])
	) {
		throw new UsageError(
			"Expected a 64-character lowercase hexadecimal media ID.",
		);
	}
	if (command === "tags") {
		const replace = values.tags !== undefined;
		const modify = values.add !== undefined || values.remove !== undefined;
		if (replace === modify) {
			throw new UsageError("Use either --tags or --add/--remove.");
		}
	}
	return { command, args, values };
}

export function editTags(current, values, api = library) {
	if (values.tags !== undefined) {
		return api.uniqueTags(values.tags);
	}
	const removed = new Set(
		api.uniqueTags(values.remove ?? []).map(api.normalizeTag),
	);
	return api.uniqueTags([
		...api
			.uniqueTags(current)
			.filter((tag) => !removed.has(api.normalizeTag(tag))),
		...(values.add ?? []),
	]);
}

export async function run(
	argv,
	{
		api = library,
		env = process.env,
		home,
		stdout = (text) => process.stdout.write(text),
		stderr = (text) => process.stderr.write(text),
		prompt = promptPassword,
		signal,
	} = {},
) {
	const parsed = parse(argv);
	if (parsed.help) {
		stdout(HELP);
		return;
	}
	const { command, args, values } = parsed;
	// Validate tags and server before asking for a password or doing any I/O.
	try {
		if (values.tags !== undefined) {
			api.uniqueTags(values.tags);
		}
		if (values.add) {
			api.uniqueTags(values.add);
		}
		if (values.remove) {
			api.uniqueTags(values.remove);
		}
		if (command === "create") {
			api.checkServer(values.server);
		}
	} catch (error) {
		throw new UsageError(error.message);
	}
	const path = values.recovery ?? recoveryPath(env, home);
	const recoveryText =
		command === "create"
			? null
			: (await readFileBounded(path, api.MAX_RECOVERY_BYTES, signal)).toString(
					"utf8",
				);
	async function singleRecovery(text, secret) {
		const manifest = await api.openRecovery(text, secret);
		if (manifest.scope !== "library") {
			throw new Error(
				"CLI requires an individual-library recovery file. Export one from Manage Library.",
			);
		}
		return manifest.libraries[0];
	}

	const password = values["password-file"]
		? await passwordFromFile(values["password-file"], signal)
		: await prompt("Password: ", signal);
	const emit = (value) => stdout(`${JSON.stringify(value)}\n`);
	async function register(publicKey, serverUrl) {
		if (!values["authorize-with"]) {
			return api.registerKey({ serverUrl, publicKey, otc: values.otc, signal });
		}
		const authorizerText = (
			await readFileBounded(
				values["authorize-with"],
				api.MAX_RECOVERY_BYTES,
				signal,
			)
		).toString("utf8");
		const secret = values["authorizer-password-file"]
			? await passwordFromFile(values["authorizer-password-file"], signal)
			: await prompt("Authorizing library password: ", signal);
		const authorizer = await singleRecovery(authorizerText, secret);
		if (new URL(authorizer.serverUrl).origin !== new URL(serverUrl).origin) {
			throw new UsageError("Authorizing library must use the same server.");
		}
		const authorizerKey = authorizer.privateKey;
		return api.registerAuthenticatedKey({
			serverUrl,
			publicKey,
			privateKey: authorizerKey,
			signal,
		});
	}
	if (command === "create") {
		if (password.length < 8) {
			throw new Error("Password must have at least 8 characters.");
		}
		if (
			!values["password-file"] &&
			password !== (await prompt("Confirm password: ", signal))
		) {
			throw new Error("Passwords do not match.");
		}
		const identity = await api.generatePrivateKey();
		await saveRecovery(
			path,
			await api.exportRecovery(
				[
					{
						name: "Library",
						serverUrl: values.server,
						privateKey: identity.privateKey,
					},
				],
				password,
				"library",
			),
			values.recovery === undefined,
			signal,
		);
		try {
			await register(identity.publicKey, values.server);
		} catch (error) {
			stderr(
				`Encrypted identity saved at ${path}. Retry: ${shellQuote(process.execPath)} ${shellQuote(process.argv[1])} register --recovery ${shellQuote(path)} ${values["authorize-with"] ? `--authorize-with ${shellQuote(values["authorize-with"])}` : "--otc CODE"}\n`,
			);
			throw error;
		}
		emit({ recovery: path, publicKey: identity.publicKey, registered: true });
		return;
	}
	const recovery = await singleRecovery(recoveryText, password);
	const privateKey = recovery.privateKey;
	const key = await api.loadKey(privateKey);
	signal?.throwIfAborted();
	const credentials = { serverUrl: recovery.serverUrl, privateKey, signal };
	switch (command) {
		case "register": {
			if (!(await api.isKeyRegistered(credentials))) {
				await register(key.registrationKey, recovery.serverUrl);
			}
			emit({ registered: true });
			break;
		}
		case "list": {
			const page = await api.list({
				...credentials,
				tags: values.tags,
				after: values.after,
			});
			emit({
				items: page.items.map(
					({ thumb: _thumb, tokens: _tokens, ...item }) => item,
				),
				next: page.next,
			});
			break;
		}
		case "upload": {
			const bytes = await readFileBounded(args[0], api.MAX_FILE_BYTES, signal);
			const result = await api.upload({
				...credentials,
				bytes,
				name: basename(args[0]),
				tags: values.tags ?? "",
				contentType: values["content-type"] ?? "application/octet-stream",
			});
			emit(result);
			break;
		}
		case "download": {
			const bytes = await api.getContent({ ...credentials, id: args[0] });
			await writeExclusive(values.output, bytes, signal);
			emit({ id: args[0], output: values.output, bytes: bytes.length });
			break;
		}
		case "delete":
			await api.remove({ ...credentials, id: args[0] });
			emit({ id: args[0], deleted: true });
			break;
		case "tags": {
			const item = await api.getMetadata({ ...credentials, id: args[0] });
			if (!item.metadata) {
				throw new Error("Could not decrypt metadata; tags were not changed.");
			}
			const tags = editTags(item.metadata.tags ?? [], values, api);
			const result = await api.updateMetadata({
				...credentials,
				id: args[0],
				metadata: { ...item.metadata, tags },
				thumb: item.thumb,
				prevMetaHash: item.metaHash,
			});
			if (result.conflict) {
				throw new Error(
					"Metadata changed concurrently; retry the command to read the current tags.",
				);
			}
			emit({ id: args[0], tags, metaHash: result.metaHash });
			break;
		}
	}
}

function shellQuote(text) {
	return `'${text.replaceAll("'", "'\\''")}'`;
}
