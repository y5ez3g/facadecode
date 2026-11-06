/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The panel's webview: this window's agents as a chat app lists its contacts - the CLI's avatar with a dot saying only what is known,
// the name and location, and the most useful known fact (PANEL-1.3, 1.4). The extension sends every card already decided; the page
// keeps only its scroll position and the card the keyboard is on, and reports what the person did (PANEL-3.1). The list is one Tab
// stop that the arrows, Home, End and the page keys move, typing goes to a card by its name, Enter or Space opens it and F2 renames
// it, as VS Code's lists have it (UX-2.3); a wheel scrolls it as one of those lists, by the person's list settings, and its
// scrollbar overlays the content without taking layout width (PANEL-3.3).

import { act, Browsing, Check, contrastAt, contrastOf, el, face, isBoolean, isNumber, isObject, isShaped, isString, isStrings, lookOf, button, page, post, saveBrowsing, savedBrowsing, strings, agoOf, agoChangesIn } from './dom';
import { Card, PanelState, PlaceKind, Scrolling } from './protocol';
import { fitCardTop } from './cardLayout';
import { cancelSmoothScroll, gliding, setScrolling, takeWheel } from './wheel';
import { installScrollbar } from './scrollbar';
import { installViewport, pageDimensions } from './viewport';

/** Defined by the build: true only in the integration suite's build, whose probe the shipped page compiles out (UX-3.2). */
declare const FACADE_TEST_MODE: boolean;

const list = document.getElementById('list') as HTMLElement;
const empty = document.getElementById('empty') as HTMLElement;
// No menu outside a card, not even the webview's own Cut/Copy/Paste; a card's context adds its own actions (PANEL-2.2). On the page's
// root, not its body: a right click below the last card lands on the root, which the body does not reach down to
document.documentElement.dataset.vscodeContext = JSON.stringify({ preventDefaultContextMenuItems: true });
list.setAttribute('role', 'listbox');
list.setAttribute('aria-label', strings.agents);

/** Where state changes are said to a screen reader: politely, and only the dot's state, never a progress tick (PANEL-1.5). */
const status = el('div', 'visually-hidden');
status.setAttribute('role', 'status');
status.setAttribute('aria-live', 'polite');
document.body.append(status);

let state: PanelState = { revision: 0, loading: true, cards: [], cardCount: 0, capabilities: { remote: false } };
let stateReceivedAt = performance.now();
/** Where the person was when this view last hid: restored on the first list drawn, without taking input focus (PANEL-3.1). */
let restoring = savedBrowsing();

const DOTS: readonly unknown[] = ['working', 'error', 'none'];
const EMPTY: readonly unknown[] = ['noFolder', 'noAgents', 'noMatch'];
const AVATAR_COLORS: readonly unknown[] = ['blue', 'orange', 'purple'];

const isMenu: Check = value => isShaped(value, { moveUp: isBoolean, moveDown: isBoolean }, { pin: isBoolean, unpin: isBoolean });
const isAvatar: Check = value => isShaped(value, { file: value => isString(value) && /^[\w.-]+$/.test(value as string) })
	|| isShaped(value, { initial: value => isString(value) && value !== '', color: value => AVATAR_COLORS.includes(value) });
const PLACE_KINDS: readonly unknown[] = ['repo', 'worktree', 'folder'];
/** A fact of a card's details whose ID is one of `ids`, with what else it has. */
const isFact = (ids: readonly unknown[], more: Readonly<Record<string, Check>> = {}): Check => value => isShaped(value, { id: id => ids.includes(id), label: isString, value: isString, ...more });
const isDetails: Check = value => isShaped(value, { location: isFact(['location'], { kind: kind => PLACE_KINDS.includes(kind) }), path: isFact(['path']),
	titleLabel: isString, description: value => isShaped(value, { title: isString, place: isString }) }, {
	summary: isFact(['title']), untitled: isString, startedBy: isString
});
const isCard: Check = value => isShaped(value, {
	runId: isString, selected: isBoolean, name: isString, alias: isString,
	dot: value => DOTS.includes(value), stateText: isString, line: isString, details: isDetails, label: isString, menu: isMenu
}, { avatar: isAvatar, startedAt: isNumber, pinned: isBoolean, repeated: value => value === true });
const isState: Check = value => isShaped(value, {
	revision: isNumber, loading: isBoolean, cards: value => Array.isArray(value) && value.every(isCard), cardCount: isNumber,
	capabilities: value => isShaped(value, { remote: isBoolean })
}, {
	filter: value => isShaped(value, { kind: value => value === 'location' || value === 'folder', id: isString, label: isString }),
	clockAt: isNumber,
	empty: value => EMPTY.includes(value),
	exited: isStrings
});

/** What the extension may send this page, by type: the fields each has beside its type and its page, and those it may have (PANEL-3.2). */
const isScrolling: Check = value => isShaped(value, { sensitivity: isNumber, fastSensitivity: isNumber, smooth: isBoolean, zoomFactor: value => isNumber(value) && (value as number) > 0 }, { scrollByPage: isBoolean, modernUI: isBoolean });
const INCOMING: { readonly [type: string]: readonly [required: Readonly<Record<string, Check>>, optional?: Readonly<Record<string, Check>>] } = {
	state: [{ state: isState }],
	outcome: [{ action: isString, ok: isBoolean }, { reason: value => value === 'gone' || value === 'failed' }],
	scrolling: [{ scrolling: isScrolling }],
	// Show Agent Details: the details of the card of run `run`, for the keyboard (PANEL-1.5)
	details: [{ run: isString }],
	...(typeof FACADE_TEST_MODE !== 'undefined' && FACADE_TEST_MODE ? { probe: [{ id: isNumber, op: isString, selector: isString }, { index: isNumber }] as const } : {})
};

/** The run of the card the keyboard is on: the list's one Tab stop, the selected card's or the first until the person moves it (UX-2.3). */
let keyed: string | undefined;
/** Whether the person put the keyboard on {@link keyed} - its keys, a click, a screen reader - rather than it following the selection. */
let keyedByPerson = false;
/** What was typed to go to a card by its name, and when its last character came: characters within 750 ms combine (UX-2.3). */
let typed = { text: '', at: -Infinity };
const TYPEAHEAD_MS = 750;
/** The keys the list acts on beside typed characters, and the menu's key (UX-2.3). */
const LIST_KEYS: ReadonlySet<string> = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp', 'Enter', ' ', 'F2', 'ContextMenu']);

/** The open actions this page sent, by action ID: a card whose open failed loses the highlight the click gave it at once. */
const opening = new Set<string>();

window.addEventListener('message', event => {
	const message: unknown = event.data;
	// What is not for this page - an earlier one's, late - it does not act on
	if (!isObject(message) || message.page !== page) {
		return;
	}
	const shape = isString(message.type) && Object.hasOwn(INCOMING, message.type as string) ? INCOMING[message.type as string] : undefined;
	if (!shape || !isShaped(message, { type: isString, page: isString, ...shape[0] }, shape[1])) {
		post({ type: 'error', message: `The panel refused a message: ${JSON.stringify(message).slice(0, 200)}` });
		return;
	}
	switch (message.type) {
		case 'state':
			state = message.state as PanelState;
			stateReceivedAt = performance.now();
			render();
			break;
		case 'outcome':
			if (opening.delete(message.action as string) && !message.ok) {
				highlight(state.cards.find(card => card.selected)?.runId);
			}
			break;
		case 'scrolling':
			setScrolling(message.scrolling as Scrolling);
			scrollbar.setOptions(message.scrolling as Scrolling);
			break;
		case 'details':
			detailsByKey(message.run as string);
			break;
		default:
			if (typeof FACADE_TEST_MODE !== 'undefined' && FACADE_TEST_MODE && message.type === 'probe') {
				post({ type: 'probed', id: message.id, value: probe(message.op as string, message.selector as string, message.index as number | undefined) });
			}
	}
});

/**
 * For the integration suite alone, compiled into its build only: clicks, focuses or reads the elements `selector` finds - the
 * `index`th, else the first - as the person would; answers what it found.
 */
const probe = typeof FACADE_TEST_MODE !== 'undefined' && FACADE_TEST_MODE ? (op: string, selector: string, index = 0): unknown => {
	const found = [...document.querySelectorAll<HTMLElement>(selector)];
	if (op === 'read') {
		return found.map(each => each.textContent ?? '');
	}
	if (op === 'style') {
		return found.map(each => {
			const style = getComputedStyle(each);
			return { width: style.width, top: style.top, bottom: style.bottom, clipBottom: style.getPropertyValue('--facade-clip-bottom') || '0px', borderRadius: style.borderRadius, backgroundColor: style.backgroundColor };
		});
	}
	if (op === 'layout') {
		const root = document.scrollingElement ?? document.documentElement;
		return { innerHeight: window.innerHeight, innerWidth: window.innerWidth, scrollHeight: root.scrollHeight, scrollTop: root.scrollTop, found: found.map(each => { const box = each.getBoundingClientRect(); return { top: box.top, bottom: box.bottom, left: box.left, right: box.right }; }) };
	}
	const target = found[index];
	if (!target) {
		return false;
	}
	switch (op) {
		case 'click':
			target.click();
			return true;
		case 'focus':
			target.focus();
			return document.activeElement === target;
		default:
			return false;
	}
} : () => undefined;

// What goes wrong here is told to the extension, for its log: the webview's own console is out of the person's sight
window.addEventListener('error', event => post({ type: 'error', message: `${event.message} (${event.filename}:${event.lineno})` }));

function render(): void {
	try {
		renderList();
		fitPlaces();
		checkQuietText();
		// Open details say their card as it is now (PANEL-1.5)
		fillDetails();
	} catch (err) {
		post({ type: 'error', message: err instanceof Error ? err.stack ?? err.message : String(err) });
	}
}

function renderList(): void {
	// Nothing until this window's runs are known: not an empty list a moment before the agents come (PANEL-1.1)
	if (state.loading) {
		empty.hidden = true;
		return;
	}
	renderEmpty();
	draw(state.cards);
	// Only the letters just drawn: a redraw that keeps its faces measures nothing
	checkInitials(untested.splice(0));
	if (restoring) {
		restoreBrowsing(restoring);
		restoring = undefined;
	}
	rememberBrowsing();
}

/** How far apart a custom CLI's letter and its circle are to be: as far as WCAG asks of text (UX-2.1). */
const READABLE = 4.5;

/** The circles a custom CLI's letter can be on, strongest first: its tint, a fainter one, the side bar's own colour (UX-2.1). */
const GROUNDS = ['', 'faint', 'unreadable'] as const;

/** Faces with a letter drawn since the letters were last tested. */
const untested: HTMLElement[] = [];

/**
 * Tests each custom CLI's letter of `faces` on its circle as the theme draws them now (UX-2.1): it goes on the strongest circle on
 * which it reads as far as WCAG asks of text, else on the one it reads best on - the side bar's own colour only where that is better,
 * as a theme may have its own text closer still. A colour the page cannot measure leaves the tint as it is.
 */
function checkInitials(faces: readonly HTMLElement[]): void {
	if (!faces.length) {
		return;
	}
	// All measured at once on each circle: three looks at the page's styles, not three for each face
	const contrasts = GROUNDS.map(ground => {
		faces.forEach(face => face.classList.remove('faint', 'unreadable'));
		if (ground) {
			faces.forEach(face => face.classList.add(ground));
		}
		return faces.map(face => {
			const style = getComputedStyle(face);
			return contrastOf(style.color, style.backgroundColor);
		});
	});
	faces.forEach((face, i) => {
		face.classList.remove('faint', 'unreadable');
		const seen = contrasts.map(each => each[i]);
		if (seen.some(each => each === undefined)) {
			return;
		}
		const readable = seen.findIndex(each => each! >= READABLE);
		const best = readable >= 0 ? readable : seen.indexOf(Math.max(...seen as number[]));
		if (GROUNDS[best]) {
			face.classList.add(GROUNDS[best]);
		}
	});
}

/** A card's face, a custom CLI's letter among those to test once it is on the page (UX-2.1). */
function newFace(avatar: Card['avatar']): HTMLElement {
	const element = face(avatar);
	if (element.classList.contains('initial')) {
		untested.push(element);
	}
	return element;
}

/** Tests every custom CLI's letter again: the theme changed. */
function checkAllInitials(): void {
	checkInitials([...list.querySelectorAll<HTMLElement>('.face.initial')]);
}

/** A theme colour as the page draws it: `property` set to the variable on an element out of sight. */
const swatch = el('span', 'visually-hidden');
swatch.setAttribute('aria-hidden', 'true');
document.body.append(swatch);
function themeColor(variable: string, property: 'color' | 'backgroundColor' = 'color'): string {
	swatch.style[property] = `var(${variable})`;
	return getComputedStyle(swatch)[property];
}

/**
 * Where the theme's quieter colour is its text colour - Light Modern's is - nothing would read as quieter than the rest: the panel's
 * quieter text takes the text colour at 75%, the dimming chosen for it, where that keeps 4.5:1 on the side
 * bar and on the hover colour (UX-2.1). A high contrast theme keeps its colours whole.
 */
function checkFlatDim(): void {
	const kind = document.body.classList;
	const text = themeColor('--vscode-foreground'), quiet = themeColor('--vscode-descriptionForeground');
	const sideBar = themeColor('--vscode-sideBar-background', 'backgroundColor'), hover = themeColor('--vscode-editorHoverWidget-background', 'backgroundColor');
	const same = (contrastOf(quiet, text) ?? 21) < 1.2;
	const readable = [sideBar, hover].every(background => (contrastAt(text, background, 0.75) ?? 0) >= 4.5);
	kind.toggle('flat-dim', same && readable && !kind.contains('vscode-high-contrast') && !kind.contains('vscode-high-contrast-light'));
}
checkFlatDim();

// The theme changed - VS Code sets its colours on the page's root and its kind on the body: the letters are tested again
const themeChanged = () => {
	checkFlatDim();
	checkAllInitials();
	fitPlaces();
	checkQuietText();
	if (detailed) {
		checkDetailQuiet();
	}
};

/**
 * Where the selected card's quieter text - its second line, short ID and Pin at 80% - would read below 4.5:1 on the selection, the
 * theme's selected text is drawn whole (UX-2.1). A translucent selection, whose look depends on what is under it, is not measured.
 */
function checkQuietText(): void {
	const selected = list.querySelector<HTMLElement>('.item.agent.selected');
	if (!selected) {
		return;
	}
	const style = getComputedStyle(selected);
	const contrast = contrastAt(style.color, style.backgroundColor, 0.8);
	document.body.classList.toggle('whole-quiet-text', contrast !== undefined && contrast < 4.5);
}

/** Whether `element` is all in view: only such a card closes up as it leaves; one out of view or cut by an edge goes at once (UX-2.2). */
function inView(element: HTMLElement): boolean {
	const { visibleTop, visibleBottom } = pageDimensions();
	const box = element.getBoundingClientRect();
	return box.top >= visibleTop && box.bottom <= visibleBottom;
}

/**
 * A card whose process ended normally, in view: it fades as its row closes up from the height it has, 150 ms accelerating as Fluent's
 * exits do, out of the Tab order and the accessibility tree at once, the cards under it rising with it. One that ends while the list
 * glides goes at once instead, the glide going on (UX-2.2, PANEL-3.3).
 */
function collapse(element: HTMLElement): void {
	element.style.setProperty('--facade-closing-height', `${element.getBoundingClientRect().height}px`);
	element.tabIndex = -1;
	element.setAttribute('aria-hidden', 'true');
	element.classList.add('closing');
	const done = (event?: AnimationEvent) => {
		if (!event || event.target === element) {
			element.remove();
		}
	};
	element.addEventListener('animationend', done);
	// Where it does not run - the view hidden - it is gone all the same
	window.setTimeout(done, 300);
}
new MutationObserver(themeChanged).observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
new MutationObserver(themeChanged).observe(document.body, { attributes: true, attributeFilter: ['class'] });

/** The saved scroll position on the cards drawn from the host's state, kept within the list. */
function restoreBrowsing(saved: Browsing): void {
	const root = document.scrollingElement ?? document.documentElement;
	root.scrollTop = Math.min(saved.scrollTop, pageDimensions().range);
	// The keyboard's card again where it still is, as the Tab stop alone: the input focus is not taken
	if (saved.target !== undefined && drawn?.has(saved.target)) {
		keyed = saved.target;
		keyedByPerson = true;
		rove();
	}
}

let browsingSaved = 0;
/** Keeps the scroll position for the view's next page, at most once a frame: as the page scrolls, and as a state redraws it. */
function rememberBrowsing(): void {
	if (restoring || browsingSaved) {
		return;
	}
	browsingSaved = requestAnimationFrame(() => {
		browsingSaved = 0;
		const root = document.scrollingElement ?? document.documentElement;
		saveBrowsing({ scrollTop: root.scrollTop, ...(keyed !== undefined ? { target: keyed } : {}) });
	});
}
window.addEventListener('scroll', rememberBrowsing, { passive: true });
installViewport();
takeWheel(reducedMotion);
const scrollbar = installScrollbar(reducedMotion);

/** One part of the empty panel: words, or a button - the main action's primary, another's secondary. */
type EmptyPart =
	| { readonly kind: 'text'; readonly text: string }
	| { readonly kind: 'button'; readonly text: string; readonly run: () => void; readonly secondary?: true };

/**
 * No card to show, said as VS Code's own views say it, for why (PANEL-1.2): no folder open - Open Folder; no agent - New Agent;
 * none in the filter's location - how many it hides, Clear Filter, and New Agent there. None while there are cards or while loading.
 */
function emptyParts(): readonly EmptyPart[] {
	switch (state.empty) {
		case 'noFolder':
			return [{ kind: 'text', text: strings.noFolder }, { kind: 'button', text: strings.openFolder, run: () => act('openFolder') }];
		case 'noAgents':
			return [{ kind: 'text', text: strings.noAgents }, { kind: 'button', text: strings.newAgent, run: () => act('new') },
				...(strings.resumeAgent ? [{ kind: 'button', text: strings.resumeAgent, run: () => act('resume'), secondary: true } as const] : [])];
		case 'noMatch':
			return [
				// A function, not the label itself: a folder or branch name may hold `$&` or `$'`, which a replacement string would expand
				{ kind: 'text', text: strings.noAgentsIn.replace('{0}', () => state.filter?.label ?? '') },
				// Hidden by the filter, not ended: how many, where there are any (PANEL-1.2)
				...state.cardCount ? [{ kind: 'text', text: state.cardCount === 1 ? strings.otherAgent : strings.otherAgents.replace('{0}', String(state.cardCount)) } as const] : [],
				{ kind: 'button', text: strings.clearFilter, run: () => act('clearFilter') },
				{ kind: 'button', text: strings.newAgent, run: () => act('new'), secondary: true }
			];
		default:
			return [];
	}
}

/** Draws the empty panel's parts, once: a state that changes nothing of it keeps its buttons and focus. */
function renderEmpty(): void {
	const parts = emptyParts();
	empty.hidden = !parts.length;
	const drawnText = JSON.stringify(parts.map(part => [part.kind, part.text, 'secondary' in part]));
	if (empty.dataset.drawn === drawnText) {
		return;
	}
	empty.dataset.drawn = drawnText;
	empty.replaceChildren(...parts.map(part => {
		switch (part.kind) {
			case 'text':
				return el('p', '', part.text);
			case 'button': {
				const container = el('div', 'button-container');
				container.append(button(part.text, part.run, part.secondary));
				return container;
			}
		}
	}));
}

/** A card on the list: its element, the parts updated in place, and what it was drawn of last. */
interface Drawn {
	readonly element: HTMLElement;
	readonly avatar: HTMLElement;
	readonly dot: HTMLElement;
	readonly name: HTMLElement;
	readonly top: HTMLElement;
	readonly line: HTMLElement;
	/** The buttons at the first line's end while the pointer is on the card: its details, its menu, and its Pin where it has one (PANEL-1.3). */
	readonly actions: HTMLElement;
	readonly info: HTMLButtonElement;
	readonly gear: HTMLButtonElement;
	readonly pinButton: HTMLButtonElement;
	look: string;
	place: string;
	card: Card;
}

/** The cards on the list by run ID, as drawn last; none before the first draw. */
let drawn: Map<string, Drawn> | undefined;
/** The cards drawn after the first draw, by when they came: one the person started scrolls into view as it is selected (PANEL-2.1). */
const arrived = new Map<string, number>();
/** How long a new card waits to be selected to scroll into view: a person's start selects it within a state or two. */
const ARRIVED_MS = 2_000;
/** The filter the cards were drawn for last: another shows its cards at once, without motion (UX-2.2). */
let drawnFilter: string | undefined;

/**
 * Draws `cards` in their order. A card keeps its element, face and dot through every change of what it says (PANEL-3.2); a new card
 * opens in 200 ms, except on the first draw, a change of filter or with reduced motion (UX-2.2); a card whose process ended
 * normally, in view, fades out in 150 ms, and any other card gone - an explicit close, a removed location, one that ends while the list
 * glides - goes at once.
 */
function draw(cards: readonly Card[]): void {
	const filter = state.filter ? `${state.filter.kind}:${state.filter.id}` : '';
	const moving = drawn !== undefined && drawnFilter === filter && !reducedMotion();
	drawnFilter = filter;
	const next = new Map<string, Drawn>();
	const said: string[] = [];
	for (const card of cards) {
		let entry = drawn?.get(card.runId);
		if (!entry) {
			entry = make(card);
			if (drawn !== undefined) {
				arrived.set(card.runId, performance.now());
			}
			if (moving) {
				animate(entry.element, 'opening');
			}
		} else if (entry.card.stateText !== card.stateText) {
			// An agent with an empty name said by its #aN, as messages name it (LIFECYCLE-3.1)
			said.push(`${card.name || card.alias}: ${card.stateText}`);
		}
		update(entry, card);
		next.set(card.runId, entry);
	}
	const exited = new Set(state.exited ?? []);
	// The keyboard's card gone, with the focus on it: the focus goes to the card in its place, as in VS Code's lists
	const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.item.agent')?.dataset.run;
	const order = [...drawn?.keys() ?? []];
	for (const [runId, entry] of drawn ?? []) {
		if (!next.has(runId)) {
			if (moving && exited.has(runId) && inView(entry.element) && !gliding()) {
				collapse(entry.element);
			} else {
				entry.element.remove();
			}
		}
	}
	// Each in its place; a card already there is not moved, so the pointer over it stays over it
	let at = list.firstElementChild;
	for (const entry of next.values()) {
		while (at?.classList.contains('closing')) {
			at = at.nextElementSibling;
		}
		if (at === entry.element) {
			at = at.nextElementSibling;
		} else {
			list.insertBefore(entry.element, at);
		}
	}
	const kept = new Set([...next.values()].map(entry => entry.element));
	for (const child of [...list.children]) {
		if (!kept.has(child as HTMLElement) && !child.classList.contains('closing')) {
			child.remove();
		}
	}
	drawn = next;
	// A new card goes last in its area (PANEL-2.1): the one the person started, selected, scrolls into view; an agent's does not
	for (const [run, at] of arrived) {
		if (!next.has(run) || performance.now() - at > ARRIVED_MS) {
			arrived.delete(run);
		}
	}
	const started = cards.find(card => card.selected && arrived.has(card.runId));
	if (started) {
		arrived.delete(started.runId);
		revealArrived(next.get(started.runId)!.element);
	}
	if (keyed !== undefined && !next.has(keyed)) {
		const gone = order.indexOf(keyed);
		const after = order.slice(gone + 1).find(run => next.has(run)) ?? order.slice(0, Math.max(gone, 0)).reverse().find(run => next.has(run));
		keyed = after;
		if (focused !== undefined && focused === order[gone] && after !== undefined) {
			next.get(after)!.element.focus({ preventScroll: true });
		}
	}
	rove();
	// A card's open details and its menu's mark go with it
	if (detailed && next.get(detailed.card.runId) !== detailed) {
		closeDetails('gone');
	}
	if (menuOn && next.get(menuOn.card.runId) !== menuOn) {
		clearMenu();
	}
	// Said once for the whole state, and only where it changed: no repeated announcement of the same state (PANEL-1.5)
	const announcement = said.join('. ');
	if (announcement && status.textContent !== announcement) {
		status.textContent = announcement;
	}
}

/** A card's element and its parts, as a chat app draws a contact: avatar with its dot, then two lines (PANEL-1.3). */
function make(card: Card): Drawn {
	const element = el('div', 'item agent');
	element.dataset.run = card.runId;
	// An option of the list, focusable by the pointer and the keys; the list's one Tab stop is the keyboard's card alone (UX-2.3)
	element.setAttribute('role', 'option');
	element.tabIndex = -1;
	const avatar = el('span', 'avatar');
	const dot = el('span', 'dot');
	avatar.append(newFace(card.avatar), dot);
	const body = el('span', 'body');
	const top = el('span', 'line top');
	const name = el('span', 'name');
	top.append(name);
	const bottom = el('span', 'line bottom');
	const line = el('span', 'title');
	bottom.append(line);
	body.append(top, bottom);
	element.append(avatar, body);
	// Its buttons, for the pointer alone: the keyboard has F2, Shift+F10 and the menu key, and a screen reader the card's description
	// (PANEL-1.3, 1.5, UX-2.3)
	const actions = el('span', 'actions');
	actions.setAttribute('aria-hidden', 'true');
	const info = action('details-button', detailsIcon());
	const gear = action('menu-button', gearIcon());
	const pinButton = action('pin-button', pinIcon(false));
	actions.append(info, gear, pinButton);
	top.append(actions);
	const entry: Drawn = { element, avatar, dot, name, top, line, actions, info, gear, pinButton, look: lookOf(card.avatar), place: '', card };
	// The pointer on the card shows its buttons: the name gives the line's end up to them, and takes it back as the pointer goes
	element.addEventListener('pointerenter', () => setHovered(entry, true));
	element.addEventListener('pointerleave', () => setHovered(entry, false));
	info.addEventListener('click', event => {
		event.stopPropagation();
		toggleDetails(entry);
	});
	gear.addEventListener('click', event => {
		event.stopPropagation();
		openMenu(entry);
	});
	pinButton.addEventListener('click', event => {
		event.stopPropagation();
		act(entry.card.menu.unpin ? 'unpin' : 'pin', entry.card.runId);
	});
	// A press on a button puts the keyboard on its card - its Tab stop and the focus, the selection where it was - so that the keys go
	// on from it once what the button opened closes (UX-2.3)
	for (const button of [info, gear, pinButton]) {
		button.addEventListener('pointerdown', () => {
			// But for the ⓘ of its own open details with the focus in them: the focus leaving would close them, and its click open them
			// again. Its click closes them, the focus going back to the card (PANEL-1.5)
			if (button !== info || detailed !== entry || !details.contains(document.activeElement)) {
				keyboardTo(entry);
			}
		});
	}
	// Its description says how long ago it started: as of now, where it gets the focus, however long since the last state (PANEL-1.5)
	element.addEventListener('focus', () => describe(entry));
	element.addEventListener('click', () => open(entry.card.runId));
	return entry;
}

/** Puts the keyboard on `entry`'s card without scrolling or selecting it, as a press on one of its buttons does. */
function keyboardTo(entry: Drawn): void {
	keyed = entry.card.runId;
	keyedByPerson = true;
	rove();
	entry.element.focus({ preventScroll: true });
	rememberBrowsing();
}

/** One of a card's buttons: no Tab stop of its own, and never the focus itself - a press gives it to the button's card (PANEL-1.3). */
function action(kind: string, icon: SVGSVGElement): HTMLButtonElement {
	const element = el('button', `action ${kind}`);
	element.type = 'button';
	element.tabIndex = -1;
	element.append(icon);
	element.addEventListener('mousedown', event => event.preventDefault());
	return element;
}

/** Whether the pointer is on `entry`'s card: the one card at a time that shows its buttons, its name refitted beside them. */
function setHovered(entry: Drawn, on: boolean): void {
	if (on) {
		for (const other of drawn?.values() ?? []) {
			if (other !== entry && other.element.classList.contains('hovered')) {
				other.element.classList.remove('hovered');
				refit(other);
			}
		}
	}
	if (entry.element.classList.contains('hovered') !== on) {
		entry.element.classList.toggle('hovered', on);
		refit(entry);
	}
}

// The pointer leaving the view leaves every card
document.addEventListener('pointerout', event => {
	if (!event.relatedTarget) {
		for (const entry of drawn?.values() ?? []) {
			setHovered(entry, false);
		}
	}
});

/** Fits `entry`'s name again: its buttons showing or gone change what the line leaves it. */
function refit(entry: Drawn): void {
	fitCardTop(entry.top, entry.name, entry.card.name || entry.card.alias);
}

/** Says on a card what its state says now, in place: no node replaced but a face whose avatar changed (PANEL-3.2). */
function update(entry: Drawn, card: Card): void {
	entry.card = card;
	const { element } = entry;
	const look = lookOf(card.avatar);
	if (look !== entry.look) {
		entry.look = look;
		entry.avatar.firstElementChild?.replaceWith(newFace(card.avatar));
	}
	if (!entry.dot.classList.contains(card.dot)) {
		entry.dot.className = `dot ${card.dot}`;
	}
	// The name's text is the fitting's, which shows as much of it as fits (PANEL-1.3)
	const place = JSON.stringify([card.pinned, card.repeated && card.alias]);
	if (place !== entry.place) {
		entry.place = place;
		entry.top.replaceChildren(entry.name, ...card.repeated ? [el('span', 'short-id', card.alias)] : [], ...card.pinned ? [pin()] : [], entry.actions);
	}
	// The Pin button where the card can be pinned or unpinned, filled where it is pinned as its passive Pin is (PANEL-1.3)
	const pinnable = card.menu.pin === true || card.menu.unpin === true;
	element.classList.toggle('pinnable', pinnable);
	element.classList.toggle('pinned', card.pinned === true);
	entry.pinButton.hidden = !pinnable;
	const pinLook = card.pinned ? 'filled' : 'outline';
	if (entry.pinButton.dataset.look !== pinLook) {
		entry.pinButton.dataset.look = pinLook;
		entry.pinButton.replaceChildren(pinIcon(card.pinned === true));
	}
	if (entry.line.textContent !== card.line) {
		entry.line.textContent = card.line;
	}
	element.classList.toggle('selected', card.selected);
	element.setAttribute('aria-selected', String(card.selected));
	element.setAttribute('aria-label', card.label);
	// What its details say, for a screen reader (PANEL-1.5)
	describe(entry);
	element.dataset.vscodeContext = contextOf(card);
}

/** Writes `entry`'s accessible description, where its words changed. */
function describe(entry: Drawn): void {
	const description = descriptionOf(entry.card);
	if (entry.element.getAttribute('aria-description') !== description) {
		entry.element.setAttribute('aria-description', description);
	}
}

const PIN_PATH = "M10.0589 2.44511C9.34701 1.73063 8.14697 1.90829 7.67261 2.79839L5.6526 6.58878L2.8419 7.52568C2.6775 7.58048 2.5532 7.71649 2.51339 7.88514C2.47357 8.0538 2.52392 8.23104 2.64646 8.35357L4.79291 10.5L2.14645 13.1465L2 14L2.85356 13.8536L5.50002 11.2071L7.64646 13.3536C7.76899 13.4761 7.94623 13.5265 8.11489 13.4866C8.28354 13.4468 8.41955 13.3225 8.47435 13.1581L9.41143 10.3469L13.1897 8.32423C14.0759 7.84982 14.2538 6.6551 13.5443 5.94305L10.0589 2.44511ZM8.55511 3.2687C8.71323 2.972 9.11324 2.91278 9.35055 3.15094L12.836 6.64889C13.0725 6.88624 13.0131 7.28448 12.7178 7.44262L8.76403 9.55921C8.65137 9.61952 8.56608 9.72068 8.52567 9.84191L7.7815 12.0744L3.92562 8.21853L6.15812 7.47436C6.27966 7.43385 6.38101 7.34823 6.44126 7.23518L8.55511 3.2687Z";

/** The Pin's outer contour alone: the filled Pin of a pinned card. */
const PIN_FILLED_PATH = PIN_PATH.slice(0, PIN_PATH.indexOf('Z') + 1);

/** VS Code's own gear and info icons - codicons `gear` and `info`: a card's menu and details (PANEL-1.3). */
const GEAR_PATH = "M7.99997 6C6.89497 6 5.99997 6.895 5.99997 8C5.99997 9.105 6.89497 10 7.99997 10C9.10497 10 9.99997 9.105 9.99997 8C9.99997 6.895 9.10497 6 7.99997 6ZM7.99997 9C7.44797 9 6.99997 8.552 6.99997 8C6.99997 7.448 7.44797 7 7.99997 7C8.55197 7 8.99997 7.448 8.99997 8C8.99997 8.552 8.55197 9 7.99997 9ZM14.565 9.715L13.279 8.628C13.245 8.599 13.213 8.567 13.184 8.533C12.888 8.186 12.931 7.667 13.279 7.372L14.565 6.285C14.693 6.177 14.742 6.003 14.691 5.844C14.386 4.903 13.882 4.04 13.219 3.308C13.139 3.22 13.027 3.172 12.912 3.172C12.865 3.172 12.818 3.18 12.773 3.196L11.186 3.761C11.144 3.776 11.1 3.788 11.056 3.796C11.006 3.805 10.956 3.81 10.907 3.81C10.515 3.81 10.167 3.532 10.094 3.134L9.79097 1.482C9.76097 1.318 9.63397 1.188 9.46997 1.153C8.98997 1.051 8.49897 1 8.00097 1C7.50297 1 7.01097 1.052 6.53097 1.153C6.36697 1.188 6.23997 1.318 6.20997 1.482L5.90797 3.134C5.89997 3.178 5.88797 3.221 5.87297 3.263C5.75197 3.6 5.43397 3.81 5.09397 3.81C5.00197 3.81 4.90797 3.794 4.81597 3.762L3.22897 3.197C3.18397 3.181 3.13597 3.173 3.08997 3.173C2.97497 3.173 2.86297 3.221 2.78297 3.309C2.11897 4.041 1.61597 4.904 1.30997 5.845C1.25797 6.004 1.30797 6.178 1.43597 6.286L2.72197 7.373C2.75597 7.402 2.78797 7.434 2.81697 7.468C3.11297 7.815 3.06997 8.334 2.72197 8.629L1.43597 9.716C1.30797 9.824 1.25897 9.998 1.30997 10.157C1.61497 11.098 2.11897 11.961 2.78297 12.693C2.86297 12.781 2.97497 12.829 3.08997 12.829C3.13697 12.829 3.18397 12.821 3.22897 12.805L4.81597 12.24C4.85797 12.225 4.90197 12.213 4.94597 12.205C4.99597 12.196 5.04597 12.192 5.09497 12.192C5.48697 12.192 5.83497 12.47 5.90797 12.868L6.20997 14.52C6.23997 14.684 6.36697 14.814 6.53097 14.849C7.01097 14.951 7.50297 15.002 8.00097 15.002C8.49897 15.002 8.99097 14.95 9.46997 14.849C9.63397 14.814 9.76097 14.684 9.79097 14.52L10.094 12.868C10.102 12.824 10.114 12.781 10.129 12.739C10.25 12.402 10.568 12.192 10.908 12.192C11 12.192 11.094 12.208 11.186 12.24L12.772 12.805C12.818 12.821 12.865 12.829 12.911 12.829C13.026 12.829 13.138 12.781 13.218 12.693C13.882 11.961 14.385 11.098 14.69 10.157C14.742 9.998 14.692 9.824 14.564 9.716L14.565 9.715ZM12.728 11.726L11.521 11.296C11.323 11.226 11.117 11.19 10.908 11.19C10.139 11.19 9.44697 11.676 9.18797 12.399C9.15397 12.492 9.12897 12.588 9.11097 12.686L8.88097 13.937C8.59097 13.979 8.29597 14 8.00097 14C7.70597 14 7.41097 13.979 7.11997 13.936L6.89097 12.685C6.73197 11.818 5.97697 11.189 5.09497 11.189C4.98697 11.189 4.87697 11.199 4.76597 11.219C4.66897 11.237 4.57397 11.262 4.47997 11.295L3.27297 11.725C2.90497 11.264 2.61097 10.759 2.39397 10.214L3.36797 9.391C3.74097 9.076 3.96797 8.634 4.00797 8.148C4.04797 7.662 3.89497 7.19 3.57797 6.818C3.51397 6.743 3.44297 6.672 3.36797 6.608L2.39397 5.785C2.61097 5.24 2.90497 4.734 3.27297 4.274L4.47997 4.704C4.67797 4.774 4.88397 4.81 5.09397 4.81C5.86297 4.81 6.55497 4.324 6.81397 3.601C6.84797 3.507 6.87297 3.411 6.89097 3.314L7.11997 2.063C7.41097 2.021 7.70597 1.999 8.00097 1.999C8.29597 1.999 8.59097 2.02 8.88097 2.062L9.10997 3.313C9.26897 4.18 10.024 4.809 10.906 4.809C11.014 4.809 11.124 4.799 11.234 4.779C11.331 4.761 11.427 4.736 11.521 4.703L12.728 4.273C13.096 4.733 13.39 5.239 13.607 5.784L12.634 6.607C12.261 6.922 12.033 7.364 11.994 7.85C11.954 8.336 12.107 8.809 12.424 9.18C12.489 9.256 12.559 9.326 12.635 9.39L13.609 10.213C13.392 10.758 13.098 11.264 12.73 11.724L12.728 11.726Z";
const INFO_PATH = "M8.49902 7.49998C8.49902 7.22384 8.27517 6.99998 7.99902 6.99998C7.72288 6.99998 7.49902 7.22384 7.49902 7.49998V10.5C7.49902 10.7761 7.72288 11 7.99902 11C8.27517 11 8.49902 10.7761 8.49902 10.5V7.49998ZM8.74807 5.50001C8.74807 5.91369 8.41271 6.24905 7.99903 6.24905C7.58535 6.24905 7.25 5.91369 7.25 5.50001C7.25 5.08633 7.58535 4.75098 7.99903 4.75098C8.41271 4.75098 8.74807 5.08633 8.74807 5.50001ZM8 1C4.13401 1 1 4.13401 1 8C1 11.866 4.13401 15 8 15C11.866 15 15 11.866 15 8C15 4.13401 11.866 1 8 1ZM2 8C2 4.68629 4.68629 2 8 2C11.3137 2 14 4.68629 14 8C14 11.3137 11.3137 14 8 14C4.68629 14 2 11.3137 2 8Z";

/** A decorative icon in a 16 px box, of `shapes` and their attributes. */
function icon(className: string, shapes: readonly (readonly [tag: string, attributes: Readonly<Record<string, string>>])[]): SVGSVGElement {
	const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', '0 0 16 16');
	svg.setAttribute('aria-hidden', 'true');
	svg.classList.add(className);
	for (const [tag, attributes] of shapes) {
		const shape = document.createElementNS('http://www.w3.org/2000/svg', tag);
		for (const [name, value] of Object.entries(attributes)) {
			shape.setAttribute(name, value);
		}
		svg.append(shape);
	}
	return svg;
}

const pinIcon = (filled: boolean) => icon('pin-icon', [['path', { d: filled ? PIN_FILLED_PATH : PIN_PATH }]]);
const gearIcon = () => icon('gear-icon', [['path', { d: GEAR_PATH }]]);
const detailsIcon = () => icon('details-icon', [['path', { d: INFO_PATH }]]);

/** A pinned card's passive Pin, filled, at its first line's end, where the Pin button takes its place under the pointer (PANEL-1.3). */
function pin(): HTMLElement {
	const element = el('span', 'pin');
	element.setAttribute('aria-hidden', 'true');
	element.append(pinIcon(true));
	return element;
}

// ---- A card's details (PANEL-1.5): its ⓘ, or Show Agent Details, opens them under the card as Fluent's info button opens its
// popover - what it works on, who the agent is, when it started and where it works: its title, its name, its time, then its place,
// each such fact after its icon. Esc, a press elsewhere, the ⓘ again, the focus leaving them,
// a scroll or the view losing the focus closes them. Open, they follow the card's state: a fact's words are written again only where
// they changed, and those with selected text in them once the selection ends ----

/**
 * The details' icons (PANEL-1.5), each VS Code's and meaning there and in Facade what it means here: codicon `comment-discussion` for a
 * conversation's title, as VS Code's chat marks a conversation; `tag` for who - its name and ID - `clockface` for when it started; and
 * for where, those Facade's location pickers give a main checkout, a worktree and a folder - `repo`, `worktree`, `folder` - with
 * `folder` for its path.
 */
const TAG_PATH = "M11 6C10.4477 6 10 5.55228 10 5C10 4.44772 10.4477 4 11 4C11.5523 4 12 4.44772 12 5C12 5.55228 11.5523 6 11 6ZM2.58722 10.1357C1.80426 9.3566 1.80426 8.0934 2.58722 7.31428L7.32688 2.59785C7.70082 2.22574 8.20735 2.01572 8.73617 2.01353L11.9867 2.00002C13.1029 1.99538 14.008 2.89877 13.9999 4.00947L13.9755 7.3725C13.9717 7.89662 13.7608 8.3982 13.3884 8.76882L8.71865 13.4157C7.93569 14.1948 6.66627 14.1948 5.88331 13.4157L2.58722 10.1357ZM3.29605 8.01964C2.90458 8.4092 2.90458 9.0408 3.29606 9.43036L6.59214 12.7103C6.98362 13.0999 7.61834 13.0999 8.00982 12.7103L12.6795 8.06346C12.8658 7.87815 12.9712 7.62736 12.9731 7.3653L12.9975 4.00227C13.0016 3.44692 12.549 2.99522 11.9909 2.99754L8.74036 3.01105C8.47595 3.01215 8.22268 3.11716 8.03571 3.30321L3.29605 8.01964Z";
const TALK_PATH = "M14.56 7.44049C14.28 7.16049 13.9 7.00049 13.5 7.00049H13V4.00049C13 2.90049 12.1 2.00049 11 2.00049H3C1.9 2.00049 1 2.90049 1 4.00049V9.00049C1 10.1005 1.9 11.0005 3 11.0005V12.0005C3 12.8205 3.93 13.2905 4.59 12.8105L7 11.0505V11.5005C7 11.9005 7.16 12.2805 7.44 12.5605C7.72 12.8405 8.1 13.0005 8.5 13.0005H10.29L12.15 14.8505C12.19 14.9005 12.25 14.9405 12.31 14.9605C12.37 14.9905 12.43 15.0005 12.5 15.0005C12.57 15.0005 12.63 14.9905 12.69 14.9605C12.78 14.9205 12.86 14.8605 12.92 14.7805C12.97 14.7005 13 14.6005 13 14.5005V13.0005H13.5C13.9 13.0005 14.28 12.8405 14.56 12.5605C14.84 12.2805 15 11.9005 15 11.5005V8.50049C15 8.10049 14.84 7.72049 14.56 7.44049ZM6.75 10.0005L4 12.0005V10.0005H3C2.45 10.0005 2 9.55049 2 9.00049V4.00049C2 3.45049 2.45 3.00049 3 3.00049H11C11.55 3.00049 12 3.45049 12 4.00049V7.00049H8.5C8.1 7.00049 7.72 7.16049 7.44 7.44049C7.16 7.72049 7 8.10049 7 8.50049V10.0005H6.75ZM14 11.5005C14 11.6305 13.95 11.7605 13.85 11.8505C13.76 11.9505 13.63 12.0005 13.5 12.0005H12.5C12.37 12.0005 12.24 12.0505 12.15 12.1505C12.05 12.2405 12 12.3705 12 12.5005V13.2905L10.85 12.1505C10.81 12.1005 10.75 12.0605 10.69 12.0405C10.63 12.0105 10.57 12.0005 10.5 12.0005H8.5C8.37 12.0005 8.24 11.9505 8.15 11.8505C8.05 11.7605 8 11.6305 8 11.5005V8.50049C8 8.37049 8.05 8.24049 8.15 8.15049C8.24 8.05049 8.37 8.00049 8.5 8.00049H13.5C13.63 8.00049 13.76 8.05049 13.85 8.15049C13.95 8.24049 14 8.37049 14 8.50049V11.5005Z";
const CLOCK_PATH = "M2 8C2 4.68629 4.68629 2 8 2C11.3137 2 14 4.68629 14 8C14 11.3137 11.3137 14 8 14C4.68629 14 2 11.3137 2 8ZM8 1C4.13401 1 1 4.13401 1 8C1 11.866 4.13401 15 8 15C11.866 15 15 11.866 15 8C15 4.13401 11.866 1 8 1ZM8 4.5C8 4.22386 7.77614 4 7.5 4C7.22386 4 7 4.22386 7 4.5V8.5C7 8.77614 7.22386 9 7.5 9H10.5C10.7761 9 11 8.77614 11 8.5C11 8.22386 10.7761 8 10.5 8H8V4.5Z";
const FOLDER_PATH = "M2 4.5V6H5.58579C5.71839 6 5.84557 5.94732 5.93934 5.85355L7.29289 4.5L5.93934 3.14645C5.84557 3.05268 5.71839 3 5.58579 3H3.5C2.67157 3 2 3.67157 2 4.5ZM1 4.5C1 3.11929 2.11929 2 3.5 2H5.58579C5.98361 2 6.36514 2.15804 6.64645 2.43934L8.20711 4H12.5C13.8807 4 15 5.11929 15 6.5V11.5C15 12.8807 13.8807 14 12.5 14H3.5C2.11929 14 1 12.8807 1 11.5V4.5ZM2 7V11.5C2 12.3284 2.67157 13 3.5 13H12.5C13.3284 13 14 12.3284 14 11.5V6.5C14 5.67157 13.3284 5 12.5 5H8.20711L6.64645 6.56066C6.36514 6.84197 5.98361 7 5.58579 7H2Z";
const PLACE_ICONS: Readonly<Record<PlaceKind, () => SVGSVGElement>> = {
	repo: () => icon('fact-icon', [['path', { d: "M12.5 12C12.776 12 13 11.776 13 11.5V3C13 1.895 12.105 1 11 1H5C3.895 1 3 1.895 3 3V13C3 14.105 3.895 15 5 15V15.5C5 15.702 5.122 15.885 5.309 15.962C5.495 16.039 5.711 15.997 5.854 15.854L6.5 15.208L7.146 15.854C7.242 15.95 7.37 16 7.5 16C7.564 16 7.63 15.987 7.691 15.962C7.878 15.885 8 15.702 8 15.5V15H12.5C12.776 15 13 14.776 13 14.5C13 14.224 12.776 14 12.5 14H8V13.5C8 13.224 7.776 13 7.5 13H5.5C5.224 13 5 13.224 5 13.5V14C4.448 14 4 13.552 4 13V12H12.5ZM4 3C4 2.448 4.448 2 5 2H11C11.552 2 12 2.448 12 3V11H4V3Z" }]]),
	worktree: () => icon('fact-icon', [['path', { d: "M12.854 14.8542L14.854 12.8542C15.049 12.6592 15.049 12.3422 14.854 12.1472L12.854 10.1472C12.659 9.95223 12.342 9.95223 12.147 10.1472C11.952 10.3422 11.952 10.6592 12.147 10.8542L13.293 12.0002H8.5C8.225 12.0002 8 11.7752 8 11.5002V5.50023C8 5.22523 8.225 5.00023 8.5 5.00023H13.293L12.147 6.14623C12.049 6.24423 12.001 6.37223 12.001 6.50023C12.001 6.62823 12.05 6.75623 12.147 6.85423C12.342 7.04923 12.659 7.04923 12.854 6.85423L14.854 4.85423C15.049 4.65923 15.049 4.34223 14.854 4.14723L12.854 2.14723C12.659 1.95223 12.342 1.95223 12.147 2.14723C11.952 2.34223 11.952 2.65923 12.147 2.85423L13.293 4.00023H8.5C7.673 4.00023 7 4.67323 7 5.50023V8.00023H1.5C1.224 8.00023 1 8.22423 1 8.50023C1 8.77623 1.224 9.00023 1.5 9.00023H7V11.5002C7 12.3272 7.673 13.0002 8.5 13.0002H13.293L12.147 14.1462C12.049 14.2442 12.001 14.3722 12.001 14.5002C12.001 14.6282 12.05 14.7562 12.147 14.8542C12.342 15.0492 12.659 15.0492 12.854 14.8542Z" }]]),
	folder: () => icon('fact-icon', [['path', { d: FOLDER_PATH }]])
};

/** A fact of the details: after its icon where it has one, what a screen reader says before it - out of sight - and its words. */
interface Fact {
	readonly row: HTMLElement;
	readonly label: HTMLElement;
	readonly value: HTMLElement;
}

function fact(className: string, mark?: SVGSVGElement): Fact {
	const row = el('div', className);
	const label = el('span', 'visually-hidden');
	const value = el('span');
	row.append(...mark ? [mark] : [], label, value);
	return { row, label, value };
}

const details = el('div', 'details');
details.hidden = true;
details.setAttribute('role', 'dialog');
details.setAttribute('aria-labelledby', 'facade-details-title');
details.setAttribute('aria-hidden', 'true');
const detailsArrow = el('span', 'details-arrow');
const detailsScroll = el('div', 'details-scroll');
detailsScroll.tabIndex = -1;
// Five facts, each an icon and one line as a name card lists its facts: its conversation's title - "No title yet" or "Title
// unavailable", quieter, where it has none; who - its name, then in the quieter colour its short ID - which names the dialog; when it
// started, as Resume Agent says a time, and who started it; where it works - its main checkout, worktree or folder, its
// icon saying which; and its path
const detailsFacts = el('div', 'details-facts');
const detailsSummary = fact('details-fact', icon('fact-icon', [['path', { d: TALK_PATH }]]));
const detailsWho = el('div', 'details-fact');
const detailsWhoText = el('span');
detailsWhoText.id = 'facade-details-title';
const detailsName = el('span');
const detailsMore = el('span', 'details-more');
detailsWhoText.append(detailsName, detailsMore);
detailsWho.append(icon('fact-icon', [['path', { d: TAG_PATH }]]), detailsWhoText);
const detailsStarted = el('div', 'details-fact');
const detailsStartedText = el('span');
detailsStarted.append(icon('fact-icon', [['path', { d: CLOCK_PATH }]]), detailsStartedText);
let placeKind: PlaceKind = 'repo';
const detailsLocation = fact('details-fact', PLACE_ICONS[placeKind]());
const detailsPath = fact('details-fact', icon('fact-icon', [['path', { d: FOLDER_PATH }]]));
detailsFacts.append(detailsSummary.row, detailsWho, detailsStarted, detailsLocation.row, detailsPath.row);
detailsScroll.append(detailsFacts);
details.append(detailsArrow, detailsScroll);
document.body.append(details);

/** The card whose details are open. */
let detailed: Drawn | undefined;
/** Whether they opened over their card: they stay where they opened while they fit there. */
let detailsAbove: boolean | undefined;
let detailsClock = 0;
/** A fact's words changed while text in it was selected: they are written once the selection ends. */
let detailsPending = false;

/** Why details close, which says where the focus goes: back to their card on Esc and the ⓘ, where the person put it else. */
type Closing = 'escape' | 'toggle' | 'outside' | 'left' | 'scroll' | 'gone' | 'menu' | 'replaced';

function toggleDetails(entry: Drawn): void {
	if (detailed === entry) {
		closeDetails('toggle');
	} else {
		openDetails(entry, false);
	}
}

/**
 * Opens `entry`'s details as Fluent's popover enters (UX-2.2): fading in as they slide 10 px in from the ⓘ's side, over 400 ms
 * slowing to a stop. For the pointer the focus stays on their card, for the keyboard it goes into them (UX-2.3).
 */
function openDetails(entry: Drawn, keyboard: boolean): void {
	if (detailed !== entry) {
		closeDetails('replaced');
		clearMenu();
		detailed = entry;
		detailsAbove = undefined;
		entry.element.classList.add('details-open');
		entry.info.classList.add('active');
		refit(entry);
		details.classList.remove('open');
		details.removeAttribute('aria-hidden');
		detailsScroll.scrollTop = 0;
		fillDetails();
		checkDetailQuiet();
		requestAnimationFrame(() => {
			if (detailed === entry) {
				details.classList.add('open');
			}
		});
	}
	if (keyboard) {
		detailsScroll.tabIndex = 0;
		detailsScroll.focus({ preventScroll: true });
	}
}

/**
 * Closes the details, the focus first: back to their card where it was in them and the person closed them - Esc, the ⓘ, a scroll - to
 * the keyboard's card where their card went, left where the person put it else. Then gone at once, as Fluent's popover leaves (UX-2.2).
 */
function closeDetails(why: Closing): void {
	const entry = detailed;
	if (!entry) {
		return;
	}
	// Closing now: the focus moved below leaves them, which closes them once only
	detailed = undefined;
	if (details.contains(document.activeElement)) {
		if (why === 'gone') {
			(keyed !== undefined ? drawn?.get(keyed)?.element : undefined)?.focus({ preventScroll: true });
		} else if (why !== 'outside' && why !== 'left') {
			entry.element.focus({ preventScroll: true });
		}
	}
	detailsPending = false;
	window.clearTimeout(detailsClock);
	entry.element.classList.remove('details-open');
	entry.info.classList.remove('active');
	refit(entry);
	detailsScroll.tabIndex = -1;
	details.setAttribute('aria-hidden', 'true');
	details.classList.remove('open');
	details.hidden = true;
}

/** Writes the open details from their card as it is now, and places them (PANEL-1.5). */
function fillDetails(): void {
	const entry = detailed;
	if (!entry) {
		return;
	}
	const { card } = entry;
	const { summary, location, path } = card.details;
	show(detailsSummary, summary ?? { label: card.details.titleLabel, value: card.details.untitled ?? '' });
	detailsSummary.row.classList.toggle('untitled', !summary);
	write(detailsName, card.name || card.alias);
	// Its short ID right after its name; an empty name's ID is its name
	write(detailsMore, card.name ? ` ${card.alias}` : '');
	write(detailsStartedText, startedOf(card, nowOf()) ?? '');
	if (location.kind !== placeKind) {
		placeKind = location.kind;
		detailsLocation.row.firstElementChild?.replaceWith(PLACE_ICONS[placeKind]());
	}
	show(detailsLocation, location);
	show(detailsPath, path);
	placeDetails(entry);
	// How long ago, as time passes with no new state, from what this card says now
	scheduleDetailsClock();
}

/** Shows `shown` with `words`, or hides it where there are none. */
function show(shown: Fact, words: { readonly label: string; readonly value: string } | undefined): void {
	shown.row.hidden = !words;
	if (words) {
		write(shown.label, words.label);
		write(shown.value, words.value);
	}
}

/** Sets `element`'s words where they changed - once the selection ends, where text in it is selected, so that the selection stays. */
function write(element: HTMLElement, text: string): void {
	if (element.textContent === text) {
		return;
	}
	const selection = getSelection();
	if (selection && !selection.isCollapsed && selection.containsNode(element, true)) {
		detailsPending = true;
		return;
	}
	element.textContent = text;
}

document.addEventListener('selectionchange', () => {
	if (detailsPending && detailed && (getSelection()?.isCollapsed ?? true)) {
		detailsPending = false;
		fillDetails();
	}
});

/** Says the open details' start again at the next age where its words change, from the start and clock their card has now (PANEL-1.5). */
function scheduleDetailsClock(): void {
	window.clearTimeout(detailsClock);
	const startedAt = detailed?.card.startedAt;
	if (startedAt !== undefined) {
		detailsClock = window.setTimeout(fillDetails, Math.max(1, Math.ceil(agoChangesIn(startedAt, nowOf()))));
	}
}

/** When the card's agent started, by the host's clock, and the agent that started it where an agent did (PANEL-1.5). */
function startedOf(card: Card, now: number): string | undefined {
	if (card.startedAt === undefined) {
		return undefined;
	}
	// "Started 5 mins ago" is one unit: a line that wraps breaks before it, or before who started it
	// Within the sentence: a language's word that begins a list's line - Vor, Il y a - begins it in lower case. A start ahead of the
	// clock is the locale's whole date and time, its letters as the locale has them (UX-2.4)
	const ago = agoOf(card.startedAt, now, strings.ago);
	const when = card.startedAt > now ? ago : (ago.charAt(0).toLocaleLowerCase(document.documentElement.lang || undefined) + ago.slice(1)).replace(/ /gu, '\u00a0');
	// Its name and short ID together too
	const by = card.details.startedBy?.replace(/ (?=#a\d+$)/u, '\u00a0');
	return (by !== undefined ? strings.startedBy : strings.started).replace(/ (?=\{0\})/u, '\u00a0').replace(/\{([01])\}/gu, (_, index: string) => index === '0' ? when : by ?? '');
}

/** Now by the host's clock: its time as it sent the state, and the time gone by since (PANEL-1.5). */
function nowOf(): number {
	return state.clockAt === undefined ? Date.now() : state.clockAt + Math.max(0, performance.now() - stateReceivedAt);
}

/** What a screen reader is told of a card beyond its label: the host's facts, and when it started, in the details' order (PANEL-1.5). */
function descriptionOf(card: Card): string {
	return [card.details.description.title, startedOf(card, nowOf()), card.details.description.place].filter(Boolean).join(', ');
}

/**
 * Puts the details under their card, as wide as it, their arrow at the ⓘ; over the card where there is more room there; no taller than
 * the room, their own content scrolling. Open, they stay on the side they opened on while they fit there.
 */
function placeDetails(entry: Drawn): void {
	// Measured without a height limit, which leaves nothing to scroll: where the person scrolled them is kept, and written back
	const scrolled = detailsScroll.scrollTop;
	details.style.maxHeight = '';
	details.hidden = false;
	const { visibleTop, visibleBottom } = pageDimensions();
	const viewWidth = document.documentElement.clientWidth;
	const card = entry.element.getBoundingClientRect(), at = entry.info.getBoundingClientRect();
	// As far in from the view's sides as the cards are, and from its ends a little more
	const side = 4, edge = 6, gap = 8;
	const width = Math.max(0, Math.min(card.width, viewWidth - 2 * side));
	const left = Math.min(Math.max(card.left, side), viewWidth - side - width);
	details.style.width = `${width}px`;
	details.style.left = `${left}px`;
	const height = details.offsetHeight;
	const below = visibleBottom - card.bottom - gap - edge, above = card.top - visibleTop - gap - edge;
	const fitsBelow = height <= below, fitsAbove = height <= above;
	const up = detailsAbove !== undefined && (detailsAbove ? fitsAbove : fitsBelow) ? detailsAbove : !fitsBelow && (fitsAbove || above > below);
	detailsAbove = up;
	const room = Math.max(0, up ? above : below);
	if (height > room) {
		details.style.maxHeight = `${room}px`;
	}
	details.style.top = `${up ? card.top - gap - Math.min(height, room) : card.bottom + gap}px`;
	if (detailsScroll.scrollTop !== scrolled) {
		detailsScroll.scrollTop = scrolled;
	}
	details.classList.toggle('above', up);
	detailsArrow.style.left = `${Math.min(Math.max(at.left + at.width / 2 - left - 6, 8), Math.max(8, width - 20))}px`;
}

/** Where the theme's quieter colour reads below 4.5:1 on the editor's hover colour, the details' icons take its text colour (UX-2.1). */
function checkDetailQuiet(): void {
	details.classList.remove('plain-quiet');
	const contrast = contrastOf(getComputedStyle(detailsMore).color, getComputedStyle(details).backgroundColor);
	details.classList.toggle('plain-quiet', contrast !== undefined && contrast < 4.5);
}

/** Show Agent Details: the card scrolled into view as little as it takes, then its details opened with the focus in them (UX-2.3). */
function detailsByKey(run: string): void {
	const entry = drawn?.get(run);
	if (!entry) {
		return;
	}
	keyboardTo(entry);
	cancelSmoothScroll();
	entry.element.scrollIntoView({ block: 'nearest' });
	// Once the scroll it may make - which closes open details - has been said
	requestAnimationFrame(() => requestAnimationFrame(() => {
		if (drawn?.get(run) === entry) {
			openDetails(entry, true);
		}
	}));
}

document.addEventListener('pointerdown', event => {
	if (detailed && !details.contains(event.target as Node) && !detailed.info.contains(event.target as Node)) {
		closeDetails('outside');
	}
}, true);
// The focus leaving them - Tab, Shift+Tab, a click into the editor - closes them, the focus where it went
details.addEventListener('focusout', event => {
	if (detailed && !details.contains(event.relatedTarget as Node | null)) {
		closeDetails('left');
	}
});
/** The keys that scroll details with the focus in them, and by how much: theirs alone, never the list's under them. */
const DETAIL_SCROLL_KEYS: Readonly<Record<string, (scroll: HTMLElement) => number>> = {
	ArrowDown: scroll => scroll.scrollTop + 40,
	ArrowUp: scroll => scroll.scrollTop - 40,
	PageDown: scroll => scroll.scrollTop + scroll.clientHeight,
	PageUp: scroll => scroll.scrollTop - scroll.clientHeight,
	Home: () => 0,
	End: scroll => scroll.scrollHeight
};
details.addEventListener('keydown', event => {
	if (event.key === 'Escape') {
		closeDetails('escape');
	} else if (Object.hasOwn(DETAIL_SCROLL_KEYS, event.key) && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
		detailsScroll.scrollTop = DETAIL_SCROLL_KEYS[event.key](detailsScroll);
	} else {
		// Copy, select and a screen reader's keys are the editor's and the page's own
		return;
	}
	event.preventDefault();
	event.stopPropagation();
});
document.addEventListener('keydown', event => {
	if (event.key === 'Escape' && detailed && !details.contains(event.target as Node)) {
		closeDetails('escape');
	}
});
window.addEventListener('blur', () => closeDetails('left'));
/**
 * A resize this frame or the next, whose layout may come after this frame's scroll events: a scroll the page makes as it fits the new size -
 * a list that no longer reaches as far - is no scroll of the person's.
 */
let resized = 0;
window.addEventListener('scroll', () => {
	if (!resized) {
		closeDetails('scroll');
	} else if (detailed) {
		placeDetails(detailed);
	}
}, { passive: true });
// The view resized: open details stay, placed again, as wide as their card and on the side they opened on while they fit there (PANEL-1.5)
window.addEventListener('resize', () => {
	if (detailed) {
		placeDetails(detailed);
	}
	const resize = ++resized;
	requestAnimationFrame(() => requestAnimationFrame(() => {
		if (resized === resize) {
			resized = 0;
		}
	}));
});
// A wheel on details taller than their room scrolls them, not the list under them
details.addEventListener('wheel', event => {
	if (detailsScroll.scrollHeight > detailsScroll.clientHeight) {
		detailsScroll.scrollTop += event.deltaY;
		event.preventDefault();
	}
}, { passive: false });

// ---- A card's menu (PANEL-2.2): its gear's, a left click as the panel's every action is; Shift+F10 and the menu key open it too. A
// right click opens nothing: on macOS it leaves an inactive window inactive, and the editor would show the menu in the active one ----

/** The card whose menu its gear or a key opened: it keeps its buttons while the editor shows the menu. */
let menuOn: Drawn | undefined;
/** Whether the editor marked the page as showing a menu since {@link menuOn}'s opened. */
let menuShown = false;

/** Opens `entry`'s menu under its gear: the webview reads the menu's context from the card, as for a right click on it (PANEL-2.2). */
function openMenu(entry: Drawn): void {
	closeDetails('menu');
	clearMenu();
	menuOn = entry;
	menuShown = false;
	entry.element.classList.add('menu-open');
	entry.gear.classList.add('active');
	refit(entry);
	const at = entry.gear.getBoundingClientRect();
	entry.element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: at.left, clientY: at.bottom }));
	// Where the editor showed none, the card does not stay as if it had one
	window.setTimeout(() => {
		if (menuOn === entry && !menuShown) {
			clearMenu();
		}
	}, 1000);
}

function clearMenu(): void {
	const entry = menuOn;
	if (!entry) {
		return;
	}
	menuOn = undefined;
	entry.element.classList.remove('menu-open');
	entry.gear.classList.remove('active');
	refit(entry);
}

// The editor marks the page while its menu shows; the card the menu is of keeps its buttons until it closes
new MutationObserver(() => {
	if (document.body.classList.contains('vscode-context-menu-visible')) {
		menuShown = true;
	} else if (menuShown) {
		menuShown = false;
		clearMenu();
	}
}).observe(document.body, { attributes: true, attributeFilter: ['class'] });

// The person's right click opens nothing; the page's own dispatch, from the gear or a key, opens the card's menu
document.addEventListener('contextmenu', event => {
	if (event.isTrusted) {
		event.preventDefault();
	}
});

/** A short name stays whole; a long one ellipsizes at its end, its short ID and Pin kept whole (PANEL-1.3). */
function fitPlaces(): void {
	for (const entry of drawn?.values() ?? []) {
		fitCardTop(entry.top, entry.name, entry.card.name || entry.card.alias);
	}
}
// The list's height changing - a card above open details closing up or arriving - moves their card: they follow it (PANEL-1.5)
new ResizeObserver(() => {
	fitPlaces();
	if (detailed) {
		placeDetails(detailed);
	}
}).observe(list);
void document.fonts.ready.then(fitPlaces);
document.fonts.addEventListener('loadingdone', fitPlaces);

/** What the menu of a card is given (PANEL-2.2): its run, and which of its actions apply now. */
function contextOf(card: Card): string {
	const { menu } = card;
	return JSON.stringify({
		webviewSection: 'agent',
		run_id: card.runId,
		...(menu.moveUp ? { webviewMoveUp: true } : {}),
		...(menu.moveDown ? { webviewMoveDown: true } : {}),
		preventDefaultContextMenuItems: true
	});
}

/** Whether the person asked for less motion: by VS Code's `workbench.reduceMotion`, as it marks the page, or their system's (UX-2.2). */
function reducedMotion(): boolean {
	return document.body.classList.contains('vscode-reduce-motion') || matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Scrolls a new card into view as little as it takes, once it has opened; nothing where it is gone by then. */
function revealArrived(element: HTMLElement): void {
	let done = false;
	const reveal = () => {
		if (done) {
			return;
		}
		done = true;
		element.removeEventListener('animationend', ended);
		if (element.isConnected) {
			cancelSmoothScroll();
			element.scrollIntoView({ block: 'nearest' });
		}
	};
	const ended = (event: AnimationEvent) => {
		if (event.target === element) {
			reveal();
		}
	};
	if (element.classList.contains('opening')) {
		element.addEventListener('animationend', ended);
		// Where it does not run - the view hidden - it is done all the same
		setTimeout(reveal, 400);
	} else {
		reveal();
	}
}

/** Has `element` move as `name` says, once; where it does not run - the view hidden - it ends all the same. */
function animate(element: HTMLElement, name: string): void {
	element.classList.add(name);
	const end = () => element.classList.remove(name);
	element.addEventListener('animationend', event => event.target === element && end(), { once: true });
	setTimeout(end, 400);
}

/**
 * Makes the keyboard's card the list's one Tab stop: the card the person moved to while it is there, else the selected card, else the
 * first. Focus and selection stay apart (PANEL-2.1).
 */
function rove(): void {
	if (!drawn?.size) {
		return;
	}
	const selected = state.cards.find(card => card.selected && drawn!.has(card.runId))?.runId;
	if (keyed === undefined || !drawn.has(keyed) || (!keyedByPerson && selected !== undefined)) {
		keyedByPerson = keyedByPerson && keyed !== undefined && drawn.has(keyed);
		keyed = keyedByPerson ? keyed : selected ?? (keyed !== undefined && drawn.has(keyed) ? keyed : drawn.keys().next().value);
	}
	for (const [runId, entry] of drawn) {
		const stop = runId === keyed ? 0 : -1;
		if (entry.element.tabIndex !== stop) {
			entry.element.tabIndex = stop;
		}
	}
}

/** The cards the keys move among, in their order: none going. */
function shownCards(): HTMLElement[] {
	return [...list.querySelectorAll<HTMLElement>('.item.agent:not(.closing)')];
}

/** Puts the keyboard on `card`: focused, scrolled into view as little as it takes (UX-2.3). */
function goTo(card: HTMLElement | undefined): void {
	if (!card) {
		return;
	}
	keyed = card.dataset.run;
	keyedByPerson = true;
	rove();
	card.focus({ preventScroll: true });
	// The keyboard ends a wheel's glide (PANEL-3.3)
	cancelSmoothScroll();
	card.scrollIntoView({ block: 'nearest' });
	rememberBrowsing();
}

/** How far Page Up and Page Down move: the cards fully in view, less one, and at least one (PANEL-3.3). */
function pageOf(cards: readonly HTMLElement[]): number {
	const { visibleTop, visibleBottom } = pageDimensions();
	const visible = cards.filter(card => {
		const box = card.getBoundingClientRect();
		return box.top >= visibleTop && box.bottom <= visibleBottom;
	}).length;
	return Math.max(1, visible - 1);
}

/** Goes to the next card whose name starts with what was typed in the last 750 ms, wrapping; a longer text may stay on its card. */
function typeahead(char: string, cards: readonly HTMLElement[], at: number): void {
	const now = performance.now();
	typed = { text: now - typed.at <= TYPEAHEAD_MS ? typed.text + char : char, at: now };
	const text = typed.text.toLocaleLowerCase();
	const start = typed.text.length > 1 ? Math.max(at, 0) : at + 1;
	for (let i = 0; i < cards.length; i++) {
		const card = cards[(start + i) % cards.length];
		if ((drawn?.get(card.dataset.run ?? '')?.card.name ?? '').toLocaleLowerCase().startsWith(text)) {
			goTo(card);
			return;
		}
	}
}

// The keys of VS Code's lists on the keyboard's card (UX-2.3); a key held with Ctrl, Alt or Cmd is the editor's. The view focused on
// no card - its rename box closed, which gives the focus back to the view alone - the key is the keyboard's card's, which has the
// focus again, as a VS Code list's focused row does
document.addEventListener('keydown', event => {
	const target = event.target as HTMLElement;
	const own = target.closest<HTMLElement>('.item.agent');
	// Only a key the list has, its menu's among them: Tab from the page goes to the Tab stop as it would
	const listKey = LIST_KEYS.has(event.key) || event.key.length === 1 || (event.key === 'F10' && event.shiftKey);
	const card = own ?? (target === document.body && keyed !== undefined && listKey ? drawn?.get(keyed)?.element : undefined);
	if (!card || event.ctrlKey || event.altKey || event.metaKey || event.isComposing) {
		return;
	}
	if (card !== target) {
		card.focus({ preventScroll: true });
	}
	const cards = shownCards();
	const at = cards.indexOf(card);
	const run = card.dataset.run!;
	const typing = typed.text !== '' && performance.now() - typed.at <= TYPEAHEAD_MS;
	switch (event.key) {
		case 'ArrowDown': goTo(cards[Math.min(at + 1, cards.length - 1)]); break;
		case 'ArrowUp': goTo(cards[Math.max(at - 1, 0)]); break;
		case 'Home': goTo(cards[0]); break;
		case 'End': goTo(cards[cards.length - 1]); break;
		case 'PageDown': goTo(cards[Math.min(at + pageOf(cards), cards.length - 1)]); break;
		case 'PageUp': goTo(cards[Math.max(at - pageOf(cards), 0)]); break;
		case 'Enter':
			open(run);
			break;
		case ' ':
			// A space within a name being typed is part of it
			if (typing) {
				typeahead(' ', cards, at);
			} else {
				open(run);
			}
			break;
		case 'F2':
			act('rename', run);
			break;
		case 'F10':
			// Shift+F10, as the menu key; F10 alone is the editor's (UX-2.3)
			if (!event.shiftKey) {
				return;
			}
			menuByKey(run);
			break;
		case 'ContextMenu':
			menuByKey(run);
			break;
		default:
			if (event.key.length !== 1) {
				return;
			}
			typeahead(event.key, cards, at);
	}
	event.preventDefault();
});

// The view focused again - its rename box closed, the person back from the editor - with the focus on no card: the keyboard's card
// has it again, as a VS Code list's focused row does
window.addEventListener('focus', () => {
	if (document.activeElement === document.body && keyed !== undefined) {
		drawn?.get(keyed)?.element.focus({ preventScroll: true });
	}
});

// The card the pointer or a screen reader focused is the keyboard's card from then on
list.addEventListener('focusin', event => {
	const run = (event.target as HTMLElement).closest<HTMLElement>('.item.agent')?.dataset.run;
	if (run !== undefined && drawn?.has(run) && (run !== keyed || !keyedByPerson)) {
		keyed = run;
		keyedByPerson = true;
		rove();
		rememberBrowsing();
	}
});

/** Opens the menu of the card of run `run` from the keyboard, under its gear as the gear's click would (PANEL-2.2, UX-2.3). */
function menuByKey(run: string): void {
	const entry = drawn?.get(run);
	if (entry) {
		openMenu(entry);
	}
}

/** Opens the card of run `run` - its terminal forward - highlighted at once, as a click does. */
function open(run: string): void {
	highlight(run);
	opening.add(act('open', run));
}

/** Highlights the card of run `runId` at once, as its terminal comes forward: the extension's state says so too, a moment later. */
function highlight(runId: string | undefined): void {
	for (const [id, entry] of drawn ?? []) {
		entry.element.classList.toggle('selected', id === runId);
		entry.element.setAttribute('aria-selected', String(id === runId));
	}
}

// The system's reduced-motion preference, which the extension host cannot read: said with ready and as it changes, for the agents'
// tab spinners under `workbench.reduceMotion: auto` (LIFECYCLE-2.2, UX-2.2)
const systemMotion = matchMedia('(prefers-reduced-motion: reduce)');
systemMotion.addEventListener('change', () => post({ type: 'motion', reduced: systemMotion.matches }));
post({ type: 'ready', reducedMotion: systemMotion.matches });
