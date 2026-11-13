/** Static child fixture: command inputs stay argv/data, never generated JavaScript. */
if (import.meta.main) {
  switch (process.argv[2]) {
    case "echo":
      console.log(
        JSON.stringify({
          args: process.argv.slice(3),
          artifactSelection: process.env.AUGGY_SCAFFOLD_PACKAGE_SPECS ?? null,
          ambientPresent: Object.hasOwn(process.env, "AUGGY_AUTHORING_AMBIENT_SECRET"),
        }),
      );
      break;
    case "reject":
      console.error("fixture rejection");
      process.exitCode = 7;
      break;
    case "secret":
      console.log(process.argv[3]);
      break;
    case "wait":
      setInterval(() => {}, 1_000);
      break;
    default:
      throw new Error("Unknown authoring command fixture mode");
  }
}
