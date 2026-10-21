/** Type declarations for the sherpa-onnx native module (loaded dynamically). */
declare module "sherpa-onnx" {
	// The package ships JS with untyped exports; we describe the surface we use.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const sherpa: any;
	export = sherpa;
}
