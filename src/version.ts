// A named import lets the bundler keep only the version, so dependency
// updates in package.json do not change the committed Action bundle.
import { version } from "../package.json";

export function getPackageVersion(): string {
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("package.json does not contain a valid version");
  }

  return version;
}
