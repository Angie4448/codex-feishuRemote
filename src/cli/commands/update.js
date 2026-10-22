// Compatibility command: explain the manual update policy without network
// access, downloads, or upstream package installation recommendations.
import { readFileSync } from "node:fs";
import { getVersionStatus } from "../../core/version-check.js";
import { createRenderer } from "../render.js";

function readPackageVersion() {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export async function run({ parsed, env, write, currentVersion = null }) {
  const renderer = createRenderer({ flags: parsed.flags, env });
  const result = getVersionStatus(currentVersion ?? readPackageVersion());
  if (renderer.json) {
    write(`${renderer.jsonText(result)}\n`);
  } else {
    write(`Current version   ${result.current}\n`);
    write("This custom build uses manual updates. Upstream update checks are disabled.\n");
    write(`Review changes in this project's repository: ${result.repositoryUrl}\n`);
  }
  return 0;
}
