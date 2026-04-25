import s, { parseSpecifier } from "./builder";

describe("Specifier", () => {
	it.each([
		[
			"image_123",
			{
				protocol: "https",
				domain: s.defaultRegistry,
				name: "library/image_123",
				ref: "latest",
			},
		],
		[
			"ubuntu:lts",
			{ protocol: "https", domain: s.defaultRegistry, name: "library/ubuntu", ref: "lts" },
		],
		[
			"registry.reset.inso-w.at/pub/docker/aniko:v1.27.2-debug",
			{
				protocol: "https",
				domain: "registry.reset.inso-w.at",
				name: "pub/docker/aniko",
				ref: "v1.27.2-debug",
			},
		],
		[
			"registry.reset.inso-w.at/pub/docker/aniko:v1.27.2-debug@sha512:ffff",
			{
				protocol: "https",
				domain: "registry.reset.inso-w.at",
				name: "pub/docker/aniko",
				ref: "sha512:ffff",
			},
		],
		[
			"registry.reset.inso-w.at/aniko:v1.27.2-debug",
			{
				protocol: "https",
				domain: "registry.reset.inso-w.at",
				name: "aniko",
				ref: "v1.27.2-debug",
			},
		],
		[
			"arm32v7/redis",
			{ protocol: "https", domain: s.defaultRegistry, name: "arm32v7/redis", ref: "latest" },
		],
		[
			"me/image:tag@sha256:aa",
			{ protocol: "https", domain: s.defaultRegistry, name: "me/image", ref: "sha256:aa" },
		],
		[
			"127.0.0.1:5000/this/is/my/image:tagged",
			{
				protocol: "http",
				domain: "127.0.0.1:5000",
				name: "this/is/my/image",
				ref: "tagged",
			},
		],
	])("parses %s", (input, expected) => {
		expect(parseSpecifier(input)).toEqual(expected);
	});
});
