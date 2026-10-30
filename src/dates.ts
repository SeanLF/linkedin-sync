// Dates as the record writes them and LinkedIn renders them ("Apr 2021",
// "2016", "Apr 1, 2021", "Mar 2026 - Present"), held as ISO strings at the
// precision given ("2021-04", "2016", "2021-04-01"). Anything that does not
// parse throws: a reader that returned null once let "Mar 2016 - garbage"
// read as "Mar 2016 - Present".

/** "2016", "2016-04" or "2016-04-01". */
export type IsoDate = string;
/** end null is Present; end undefined is no end at all (a certification that does not expire). */
export interface Range {
	start: IsoDate;
	end: IsoDate | null | undefined;
}

const monthNames = (month: "short" | "long") =>
	Array.from({ length: 12 }, (_, i) =>
		new Temporal.PlainDate(2000, i + 1, 1).toLocaleString("en-US", { month }),
	);
export const MONTHS = monthNames("short");
export const MONTH_NAMES = monthNames("long");

// The abbreviation or the full name, nothing between: a prefix match read "Junk 2015" as June.
const monthNumber = (name: string): number | undefined => {
	const n = name.toLowerCase();
	const i = MONTH_NAMES.findIndex(
		(full, k) => n === full.toLowerCase() || n === MONTHS[k]?.toLowerCase(),
	);
	return i < 0 ? undefined : i + 1;
};

const DAY = /^([A-Za-z]{3,})\.?\s+(\d{1,2}),\s*(\d{4})$/u;
const MONTH = /^([A-Za-z]{3,})\.?\s+(\d{4})$/u;

/** "Apr 2021" -> "2021-04", "2016" -> "2016", "Apr 1, 2021" -> "2021-04-01"; null if unparseable. */
export function parseDate(text: string): IsoDate | null {
	const t = text.trim();
	if (/^\d{4}$/u.test(t)) return t;
	const [, name = "", a = "", b] = DAY.exec(t) ?? MONTH.exec(t) ?? [];
	const month = monthNumber(name);
	if (month === undefined) return null;
	if (b === undefined)
		return Temporal.PlainYearMonth.from({ year: Number(a), month }).toString();
	try {
		return Temporal.PlainDate.from(
			{ year: Number(b), month, day: Number(a) },
			{ overflow: "reject" },
		).toString();
	} catch {
		return null;
	}
}

/** ISO at any precision back to LinkedIn's rendering. */
export function dateLabel(iso: IsoDate): string {
	const [y, m, d] = iso.split("-");
	const mon = m === undefined ? undefined : MONTHS[Number(m) - 1];
	if (!(y && /^\d{4}$/u.test(y)) || (m !== undefined && !mon))
		throw new Error(`not an ISO date: ${JSON.stringify(iso)}`);
	if (!mon) return y;
	return d ? `${mon} ${Number(d)}, ${y}` : `${mon} ${y}`;
}

/** "Mar 2026 - Present", "2010 - 2014" or a lone "Mar 2018"; throws on anything else. */
export function parseRange(raw: string): Range {
	const [a = "", b, ...rest] = raw.split(/\s+[-–]\s+|\s*–\s*/u);
	const start = parseDate(a);
	const fail = () => new Error(`cannot read dates ${JSON.stringify(raw)}`);
	if (!start || rest.length) throw fail();
	if (b === undefined) return { start, end: undefined };
	if (/^present$/iu.test(b.trim())) return { start, end: null };
	const end = parseDate(b);
	if (!end) throw fail();
	return { start, end };
}

export function rangeLabel({ start, end }: Range): string {
	if (end === undefined) return dateLabel(start);
	return `${dateLabel(start)} - ${end === null ? "Present" : dateLabel(end)}`;
}

/** A range LinkedIn renders with a duration ("Jan 2025 - Nov 2025 · 11 mos"), canonicalised; unparseable stays as is. */
export function renderedRange(s: string | undefined): string | undefined {
	const head = s?.split(" · ")[0]?.trim();
	if (!head) return undefined;
	try {
		return rangeLabel(parseRange(head));
	} catch {
		return head;
	}
}

/** A month-precision range: what a position, project or volunteer role takes. */
export function monthRange(raw: string, what: string): Range {
	const d = parseRange(raw);
	const monthly = (x: IsoDate) => x.length === 7;
	if (d.end === undefined || !monthly(d.start) || (d.end && !monthly(d.end)))
		throw new Error(
			`${what} dates are "Mon YYYY - Mon YYYY" or "Mon YYYY - Present", got ${JSON.stringify(raw)}`,
		);
	return d;
}

/** "2020-06-01" or "2020-06" -> "6/1/2020", what the publication date box takes. */
export function usDate(iso: IsoDate): string {
	const [y, m, d = "1"] = iso.split("-");
	if (!m) throw new Error(`a publication date needs a month: ${iso}`);
	return `${Number(m)}/${Number(d)}/${y}`;
}

/** Days since an ISO instant, or null when it does not parse. */
export function ageDays(instant: string | undefined): number | null {
	try {
		if (!instant) return null;
		const since = Temporal.Now.instant().since(Temporal.Instant.from(instant));
		return since.total("hours") / 24;
	} catch {
		return null;
	}
}
