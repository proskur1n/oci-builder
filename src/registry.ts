import { createHash } from "node:crypto";

export type Descriptor = {
	mediaType: string;
	digest: string;
	size: number;
};

// Both ImageIndex and ImageManifest are called manifests in the OCI specification.
// ImageIndex supports platform-specific images. It contains descriptors to ImageManifest(s)
// of individual platforms.
export type ImageIndex = {
	schemaVersion: number;
	mediaType: string;
	manifests: (Descriptor & {
		platform?: {
			architecture: string;
			os: string;
		};
	})[];
};
export type ImageManifest = {
	schemaVersion: number;
	mediaType: string;
	config: Descriptor;
	layers: Descriptor[];
};

export type ImageConfig = {
	architecture: string;
	os: string;
	config?: ImageConfigConfig;
	rootfs: {
		type: string;
		diff_ids: string[];
	};
};

export type ImageConfigConfig = {
	User?: string;
	Env?: string[];
	Entrypoint?: string[];
	Cmd?: string[];
	WorkingDir?: string;
};

export type Blob = {
	descriptor: Descriptor;
	payload: BodyInit;
};

export type Credentials = {
	username: string;
	password: string;
};

export class RegistryClient {
	private authHeaders: Map<string, string> = new Map();
	private apiUrl: string;
	private credentials: Credentials | undefined;

	constructor(protocol: string, registry: string, namespace: string, credentials?: Credentials) {
		this.apiUrl = new URL(`/v2/${namespace}`, protocol + "://" + registry).toString();
		this.credentials = credentials;
	}

	// Spec: "While the use of an image index is OPTIONAL for image providers, image
	// consumers SHOULD be prepared to process them".
	async pullManifest(
		ref: string,
		opts: { arch?: string; os?: string } = {},
	): Promise<ImageManifest> {
		const res = await this.callApi(`/manifests/${ref}`, {
			headers: {
				Accept: "application/vnd.oci.image.index.v1+json,application/vnd.oci.image.manifest.v1+json",
			},
		});
		if (!res.ok) {
			this.throw(`Failed to pull manifest with ref ${ref}`, res);
		}
		const json = (await res.json()) as ImageIndex | ImageManifest;

		if (!("manifests" in json)) {
			// This is a single-platform image.
			return json;
		}

		// Select the manifest that matches the requested architecture and operating system.
		let manifest = json.manifests.find(
			m =>
				(!opts.arch || m.platform?.architecture === opts.arch) &&
				(!opts.os || m.platform?.os === opts.os),
		);
		if (!manifest) {
			manifest = json.manifests.find(m => !m.platform);
		}
		if (!manifest) {
			this.throw(`No manifest found for ref ${ref} and ${opts.arch}/${opts.os}`);
		}

		return this.pullImageManifest(manifest.digest);
	}

	async pullImageIndex(ref: string): Promise<ImageIndex> {
		const res = await this.callApi(`/manifests/${ref}`, {
			headers: {
				Accept: "application/vnd.oci.image.index.v1+json",
			},
		});
		if (res.ok) {
			return await res.json();
		} else {
			this.throw(`Failed to pull image index with ref ${ref}`, res);
		}
	}

	async pullImageManifest(ref: string): Promise<ImageManifest> {
		const res = await this.callApi(`/manifests/${ref}`, {
			headers: {
				Accept: "application/vnd.oci.image.manifest.v1+json",
			},
		});
		if (res.ok) {
			return await res.json();
		} else {
			this.throw(`Failed to pull image manifest with ref ${ref}`, res);
		}
	}

	async pullImageConfig(d: Descriptor): Promise<ImageConfig> {
		const res = await this.callApi(`/blobs/${d.digest}`, {
			headers: {
				Accept: "application/vnd.oci.image.config.v1+json",
			},
		});
		if (res.ok) {
			return await res.json();
		} else {
			this.throw(`Failed to pull image config ${d.digest}`, res);
		}
	}

	async blobExists(d: Descriptor): Promise<boolean> {
		const res = await this.callApi(`/blobs/${d.digest}`, {
			method: "HEAD",
		});
		if (res.ok) {
			return true;
		}
		if (res.status === 404) {
			return false;
		}
		throw new Error(`Failed to check existence of blob with ref ${d.digest}`);
	}

	async pullBlob(d: Descriptor): Promise<ReadableStream> {
		const res = await this.callApi(`/blobs/${d.digest}`, {
			method: "GET",
		});
		if (res.ok) {
			return res.body!;
		} else {
			this.throw(`Failed to pull layer ${d.digest}`, res);
		}
	}

	async pushManifest(manifest: ImageIndex | ImageManifest, tag?: string): Promise<Descriptor> {
		const data = new TextEncoder().encode(JSON.stringify(manifest));
		const hashHex = createHash("sha256").update(data).digest("hex");

		const descriptor: Descriptor = {
			mediaType: manifest.mediaType,
			digest: `sha256:${hashHex}`,
			size: data.length,
		};

		const ref = tag ?? descriptor.digest;
		const res = await this.callApi(`/manifests/${ref}`, {
			method: "PUT",
			headers: {
				"Content-Type": descriptor.mediaType,
				"Content-Length": descriptor.size + "",
			},
			body: data,
		});
		if (!res.ok) {
			this.throw(`Failed to push manifest ${descriptor.digest}`, res);
		}

		return descriptor;
	}

	async pushBlob(blob: Blob): Promise<boolean> {
		if (await this.blobExists(blob.descriptor)) {
			return false;
		}

		const res = await this.callApi(`/blobs/uploads/`, {
			method: "POST",
		});
		if (!res.ok) {
			this.throw(`Failed to initiate blob push for ${blob.descriptor.digest}`, res);
		}

		const locationHeader = res.headers.get("Location");
		if (!locationHeader) {
			this.throw("Missing Location header", res);
		}

		const headers = new Headers({
			"Content-Type": "application/octet-stream",
			"Content-Length": blob.descriptor.size + "",
		});
		const uploadUrl = new URL(locationHeader);
		uploadUrl.searchParams.set("digest", blob.descriptor.digest);

		let tries = 0;

		while (true) {
			++tries;

			const authKey = uploadUrl.toString();
			const auth = this.authHeaders.get(authKey);
			if (auth) {
				headers.set("Authorization", auth);
			}

			const res = await fetch(uploadUrl, {
				method: "PUT",
				headers,
				body: blob.payload,
				// @ts-ignore: See https://github.com/microsoft/TypeScript-DOM-lib-generator/issues/1483
				duplex: "half",
			});
			if (res.ok) {
				return true;
			}
			if (res.status === 401) {
				if (tries > 1) {
					this.throw("Registry rejects specified credentials", res);
				}
				const wwwAuthenticate = res.headers.get("www-authenticate");
				if (!wwwAuthenticate) {
					this.throw("Missing www-authenticate header", res);
				}
				this.authHeaders.set(
					authKey,
					await authenticate(wwwAuthenticate, this.credentials),
				);
			} else {
				this.throw(`Failed to push blob ${blob.descriptor.digest}`, res);
			}
		}
	}

	async pushImageConfig(image: ImageConfig): Promise<Descriptor> {
		const payload = new TextEncoder().encode(JSON.stringify(image));
		const hashHex = createHash("sha256").update(payload).digest("hex");

		const descriptor: Descriptor = {
			mediaType: "application/vnd.oci.image.config.v1+json",
			digest: `sha256:${hashHex}`,
			size: payload.length,
		};
		await this.pushBlob({ descriptor, payload });

		return descriptor;
	}

	async callApi(endpoint: string, params: RequestInit): Promise<Response> {
		const url = this.apiUrl + endpoint;
		params = structuredClone(params);
		params.headers = new Headers(params.headers);

		let tries = 0;

		while (true) {
			++tries;

			const auth = this.authHeaders.get(this.apiUrl);
			console.log("auth =", auth);
			if (auth) {
				params.headers.set("Authorization", auth);
			}
			console.log("Printing headers");
			for (const [k, v] of params.headers.entries()) {
				console.log(" -", k, v);
			}
			// TODO
			console.log(`tries=${tries}, params.headers are ${JSON.stringify(params.headers)}`);

			const res = await fetch(url, params);
			if (res.status === 401) {
				if (tries > 1) {
					this.throw("Registry rejects specified credentials", res);
				}
				const wwwAuthenticate = res.headers.get("www-authenticate");
				if (!wwwAuthenticate) {
					this.throw("Missing www-authenticate header", res);
				}
				this.authHeaders.set(
					this.apiUrl,
					await authenticate(wwwAuthenticate, this.credentials),
				);
			} else {
				return res;
			}
		}
	}

	private throw(msg: string, res?: Response): never {
		msg += `\napi = ${this.apiUrl}`;
		if (res) {
			msg += `\nurl = ${res.url}`;
			msg += `\nstatus = ${res.status} ${res.statusText}`;
			msg += `\nheaders = ${JSON.stringify(res.headers, null, 2)}`;
			// TODO
			console.log("headers: ", res?.headers + "");
		}
		throw new Error(msg);
	}
}

async function authenticate(
	wwwAuthenticate: string,
	credentials: Credentials | undefined,
): Promise<string> {
	if (!wwwAuthenticate.startsWith("Bearer ")) {
		throw new Error(`Unknown www-authenticate: '${wwwAuthenticate}'`);
	}

	const params = new URLSearchParams();
	for (const [, name, value] of wwwAuthenticate.matchAll(/(\w+)="(.*?)"/g)) {
		params.append(name!, value!);
	}
	const realm = params.get("realm");
	if (!realm) {
		throw new Error(`Invalid www-authenticate: '${wwwAuthenticate}'`);
	}
	params.delete("realm");

	const url = realm + "?" + params;
	console.log("\tAuth for", decodeURIComponent(url));
	const headers = new Headers();
	if (credentials) {
		headers.set(
			"Authorization",
			"Basic " + btoa(credentials.username + ":" + credentials.password),
		);
	}
	const res = await fetch(url, { headers });
	if (!res.ok) {
		throw new Error(`Authentication failed ${res.status} ${res.statusText}`);
	}
	const body = await res.text();
	console.log("TODO body", body);
	const token = JSON.parse(body)["token"];
	if (!token) {
		throw new Error(`Invalid authentication response: ${body}`);
	}
	console.log("\t\tSuccess");
	// TODO
	return "Bearer " + token;
}
