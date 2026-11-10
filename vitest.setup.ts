// The tests never reach a real Scan host: every Scan call goes to a stubbed
// fetch or a fake ScanApi, and an unset host list falls back to the default
// public host only inside code paths the tests stub.
delete process.env.SCAN_RECORD_HOSTS;
// Nor a forward or a Super Validator spacing set in the shell: every host parse reads them.
delete process.env.SCAN_FORWARD_PORTS;
delete process.env.SCAN_RECORD_SV_SPACING_MS;
