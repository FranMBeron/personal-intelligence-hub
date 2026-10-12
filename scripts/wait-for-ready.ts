const target = process.argv[2];
if (target === undefined) {
  process.stderr.write("Usage: tsx scripts/wait-for-ready.ts <health-url>\n");
  process.exitCode = 2;
} else {
  const deadline = Date.now() + 60_000;
  let ready = false;
  while (!ready && Date.now() < deadline) {
    try {
      const response = await fetch(target);
      ready = response.ok;
    } catch {
      ready = false;
    }
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!ready) {
    process.stderr.write("Service did not become ready before the timeout.\n");
    process.exitCode = 1;
  }
}
