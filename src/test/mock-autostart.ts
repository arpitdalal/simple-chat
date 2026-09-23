/** E2e stand-in — no real login-item registration in the browser harness. */
let enabled = false;

export async function enable() {
  enabled = true;
}

export async function disable() {
  enabled = false;
}

export async function isEnabled() {
  return enabled;
}
