import { ImageConfigConfig, Blob, RegistryClient, Descriptor, Credentials } from "./registry.js";
import { createHash, Hash, randomUUID } from "node:crypto";
import { createGzipEncoder, createTarPacker, TarPackController } from "modern-tar";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import { createReadStream, createWriteStream } from "node:fs";

const variables = {
	defaultRegistry: "index.docker.io",
	officialImagePrefix: "library/",
};
export default variables;

const ARCH = mapArchToGoArch(process.arch);
const OS = process.platform;

// Docker images use GOARCH variants to specify architectures.
function mapArchToGoArch(arch: string): string {
	switch (arch) {
		case "x64":
			return "amd64";
		case "ia32":
			return "386";
		case "mipsel":
			return "mipsle";
		default:
			return arch;
	}
}

export type AddedFile = { src: string; dst: string };

export class Builder {
	private readonly base: Specifier;
	private readonly newLayers: AddedFile[][] = [];
	config: ImageConfigConfig = {};
	// Key is a registry domain. Use empty string ("") as key for the default
	// registry (`variables.defaultRegistry`).
	credentials: { [domain: string]: { username: string; password: string } } = {};

	constructor(baseImage: string | Specifier) {
		this.base = typeof baseImage === "string" ? parseSpecifier(baseImage) : baseImage;
	}

	addFiles(files: AddedFile[]) {
		this.newLayers.push(files);
	}

	async push(destination: string | Specifier): Promise<Descriptor> {
		destination = typeof destination === "string" ? parseSpecifier(destination) : destination;

		const baseClient = new RegistryClient(
			this.base.protocol,
			this.base.domain,
			this.base.name,
			undefined, // TODO
			// this.auth(this.base.domain),
		);
		const destClient = new RegistryClient(
			destination.protocol,
			destination.domain,
			destination.name,
			this.auth(destination.domain),
		);

		console.log(`Pull manifest for ${ARCH}/${OS}`);
		const baseManifest = await baseClient.pullManifest(this.base.ref, { arch: ARCH, os: OS });
		console.log("Pull image config");
		const baseConfig = await baseClient.pullImageConfig(baseManifest.config);

		for (const descriptor of baseManifest.layers) {
			console.log(`Push base layer ${descriptor.digest}`);
			const pushed = await destClient.pushBlob({
				descriptor,
				payload: await baseClient.pullBlob(descriptor),
			});
			if (pushed) {
				console.log("\tBlob created");
			} else {
				console.log("\tAlready exists");
			}
		}

		const layers = [...baseManifest.layers];
		const rawDigests = [...baseConfig.rootfs.diff_ids];

		for (const addedFiles of this.newLayers) {
			const layer = new CreatedLayer();
			try {
				for (const file of addedFiles) {
					await layer.addFile(file);
				}
				await layer.push(destClient);
				layers.push(layer.descriptor);
				rawDigests.push(`sha256:${layer.rawHash.digest("hex")}`);
			} finally {
				await layer.dispose();
			}
		}

		console.log(`Push image manifest to ${formatSpecifier(destination)}`);
		const config: Descriptor = await destClient.pushImageConfig({
			architecture: ARCH,
			os: OS,
			config: mergeConfigs(baseConfig.config ?? {}, this.config),
			rootfs: {
				type: "layers",
				diff_ids: rawDigests,
			},
		});
		return await destClient.pushManifest(
			{
				schemaVersion: 2,
				mediaType: "application/vnd.oci.image.manifest.v1+json",
				config,
				layers,
			},
			destination.ref,
		);
	}

	private auth(domain: string): Credentials | undefined {
		if (this.credentials[domain]) {
			return this.credentials[domain];
		}
		if (domain === variables.defaultRegistry) {
			return this.credentials[""];
		}
		return undefined;
	}
}

function mergeConfigs(a: ImageConfigConfig, b: ImageConfigConfig): ImageConfigConfig {
	const merged = { ...a, ...b };
	if (a.Env && b.Env) {
		merged.Env = [...a.Env, ...b.Env];
	}
	if (b.Entrypoint) {
		if (b.Cmd) {
			merged.Cmd = b.Cmd;
		} else {
			delete merged.Cmd;
		}
	}
	return merged;
}

export type Specifier = {
	protocol: string;
	domain: string;
	name: string;
	ref: string;
};

const PROTOCOL = /(http:\/\/|https:\/\/)/;
const DOMAIN = /([^/]+\.[^/]+\/)/;
const NAME = /([^:@]+)/;
const TAG = /(:[^@]+)/;
const DIGEST = /(@.+)/;

const REGEX = new RegExp(
	`^${PROTOCOL.source}?${DOMAIN.source}?${NAME.source}${TAG.source}?${DIGEST.source}?$`,
);

/**
 * Translates docker registry image specifiers like ubuntu:lts to
 * a Specifier metadata object.
 */
export function parseSpecifier(specifier: string): Specifier {
	// Inspired by
	// https://github.com/google/nodejs-container-image-builder/blob/master/src/image-specifier.ts

	const match = specifier.match(REGEX);
	if (!match) {
		throw new Error("Invalid image specifier " + specifier);
	}
	// console.log(match);
	let [, , domain, name, tag, digest] = match;
	name = name!;

	if (domain) {
		domain = domain.replace(/\/$/, "");
	} else {
		domain = variables.defaultRegistry;
		if (name.indexOf("/") < 0) {
			// Dockerhub prefixes its official images with "library/".
			// ubuntu:latest => library/ubuntu:latest
			name = variables.officialImagePrefix + name;
		}
	}

	const protocol = boldlyAssumeProtocol(domain);

	const ref = (digest ?? tag ?? ":latest").slice(1);

	return { protocol, domain, name, ref };
}

function formatSpecifier(s: Specifier): string {
	return s.protocol + "://" + s.domain + "/" + s.name + (s.ref.includes(":") ? "@" : ":") + s.ref;
}

function boldlyAssumeProtocol(registry: string) {
	// from
	// https://github.com/google/go-containerregistry/blob/efb7e1b888e142e2c66af20fd44e76a939b2cc3e/pkg/name/registry.go#L28
	// match a.local:0000
	if (/.*\.local(?:host)?(?::\d{1,5})?$/.test(registry)) return "http";
	// Detect the loopback IP (127.0.0.1)
	if (registry.indexOf("localhost:") > -1) return "http";
	if (registry.indexOf("127.0.0.1") > -1) return "http";
	if (registry.indexOf("::1") > -1) return "http";

	return "https";
}

interface Layer extends Blob {
	rawHash: Hash; // Hash of not gzipped (raw) content.
}

class CreatedLayer implements Layer {
	backingFile: string;
	rawHash = createHash("sha256");
	gzipHash = createHash("sha256");
	gzipSize = 0;
	digest?: string;
	controller: TarPackController;
	written: Promise<void>;

	constructor() {
		this.backingFile = path.join(os.tmpdir(), `oci-builder-layer-${randomUUID()}.tar.gz`);

		const { readable, controller } = createTarPacker();
		this.controller = controller;

		this.written = readable
			.pipeThrough(
				new TransformStream({
					transform: (chunk, controller) => {
						this.rawHash.update(chunk);
						controller.enqueue(chunk);
					},
				}),
			)
			.pipeThrough(createGzipEncoder())
			.pipeThrough(
				new TransformStream({
					transform: (chunk, controller) => {
						this.gzipHash.update(chunk);
						this.gzipSize += chunk.length;
						controller.enqueue(chunk);
					},
				}),
			)
			.pipeTo(Writable.toWeb(createWriteStream(this.backingFile)));
	}

	async dispose() {
		return fs.unlink(this.backingFile);
	}

	async addFile(file: AddedFile) {
		const stack: AddedFile[] = [file];

		while (stack.length > 0) {
			const { src, dst } = stack.pop()!;
			const stat = await fs.stat(src);

			if (stat.isFile()) {
				const name = dst.endsWith("/") ? path.join(dst, path.basename(src)) : dst;
				// console.log(`Copy ${src} to ${name}`);
				const stream = this.controller.add({
					name,
					size: stat.size,
					mtime: stat.mtime,
					mode: stat.mode,
					uid: 0,
					gid: 0,
				});
				await Readable.toWeb(createReadStream(src)).pipeTo(stream);
			} else if (stat.isDirectory()) {
				if (!dst.endsWith("/")) {
					throw new Error(`Directory ${src} cannot overwrite non-directory ${dst}`);
				}
				for (const child of await fs.readdir(src, { withFileTypes: true })) {
					stack.push({
						src: path.join(src, child.name),
						dst: path.join(dst, child.isDirectory() ? child.name + "/" : child.name),
					});
				}
			} else {
				throw new Error(`Entry ${src} is neither a file nor a directory`);
			}
		}
	}

	get descriptor(): Descriptor {
		if (!this.digest) {
			this.digest = `sha256:${this.gzipHash.digest("hex")}`;
		}
		return {
			mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
			digest: this.digest,
			size: this.gzipSize,
		};
	}

	get payload(): BodyInit {
		return Readable.toWeb(createReadStream(this.backingFile)) as ReadableStream;
	}

	async push(client: RegistryClient) {
		this.controller.finalize();
		await this.written;
		console.log(`Push app layer ${this.descriptor.digest}`);
		await client.pushBlob(this);
	}
}
