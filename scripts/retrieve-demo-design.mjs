import handoff from './design-handoff.cjs';

// Compatibility entry point; selection and destination now come from stdin.
handoff.runCli().catch(() => {
  console.error(
    'Design retrieval failed. Check the current local connection and scope; no credentials were saved.',
  );
  process.exitCode = 1;
});
