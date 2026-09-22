/**
 * systemd sets JOURNAL_STREAM when stdout is wired to the journal, and it parses a
 * leading <N> syslog priority off each line. Emitting those makes `journalctl -p err`
 * able to pick the failures out. Run by hand the prefix is just noise, so fall back to
 * a timestamp instead -- the journal already stamps every line it stores.
 */
const UNDER_JOURNALD = process.env.JOURNAL_STREAM !== undefined;

function write(stream: NodeJS.WriteStream, priority: number, message: string): void {
	stream.write(UNDER_JOURNALD ? `<${priority}>${message}\n` : `${new Date().toISOString()} ${message}\n`);
}

export const log = {
	info: (message: string): void => write(process.stdout, 6, message),
	warn: (message: string): void => write(process.stdout, 4, message),
	error: (message: string): void => write(process.stderr, 3, message)
};
