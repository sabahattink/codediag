import packageMetadata from "../package.json";

export function getPackageVersion(): string {
  if (
    typeof packageMetadata.version !== "string" ||
    packageMetadata.version.length === 0
  ) {
    throw new Error("package.json does not contain a valid version");
  }

  return packageMetadata.version;
}
