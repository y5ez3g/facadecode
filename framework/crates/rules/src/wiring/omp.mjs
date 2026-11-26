// Facade Code: report the active session and its turn state from Oh My Pi's extension events.
import fs from 'node:fs';
import path from 'node:path';

function session(ctx) {
	const id = ctx.sessionManager.getSessionId()?.toLowerCase();
	const transcript = ctx.sessionManager.getSessionFile();
	const named = typeof id === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id);
	const saved = typeof transcript === 'string' && path.isAbsolute(transcript) && !/[\r\n]/.test(transcript);
	const temporary = path.join(path.dirname(reportFile), '.session.omp.' + process.pid);
	try {
		fs.writeFileSync(temporary, named && saved ? id + '\n' + transcript + '\n' : '', { mode: 0o600 });
		fs.renameSync(temporary, reportFile);
	} catch {
		// A removed run has no directory to report to.
	}
}

function state(value, kind) {
	process.stdout.write('\x1b]7501;state=' + value + (kind ? ':kind=' + kind : '') + '\x07');
}

// OMP announces the servers it connects. The run's own is none of the person's, so its conversation
// opens as it does without Facade. OMP ignores a status of a type it does not know.
function quiet(status) {
	if (Array.isArray(status?.serverNames)) {
		status.serverNames = status.serverNames.filter(name => name !== server);
	} else if (status?.serverName === server && status.type !== 'failed') {
		status.type = 'managed';
	}
}

export default function (omp) {
	omp.events?.on?.('mcp:connection-status', quiet);
	for (const event of ['session_start', 'session_switch', 'session_branch']) {
		omp.on(event, (_event, ctx) => {
			if (!ctx.hasUI) return;
			session(ctx);
			state('idle');
		});
	}
	omp.on('agent_start', (_event, ctx) => {
		if (ctx.hasUI) state('working');
	});
	omp.on('agent_end', (event, ctx) => {
		if (!ctx.hasUI || (event.willContinue && !event.awaitingAsyncWork)) return;
		const last = event.messages.filter(message => message.role === 'assistant').at(-1);
		state(last?.stopReason === 'error' ? 'error' : 'done');
	});
	omp.on('tool_approval_requested', (_event, ctx) => {
		if (ctx.hasUI) state('blocked', 'permission');
	});
	omp.on('tool_approval_resolved', (_event, ctx) => {
		if (ctx.hasUI) state('working');
	});
}
