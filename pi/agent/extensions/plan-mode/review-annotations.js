function normalize(markdown) {
	return markdown.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trimEnd();
}

function indentation(line) {
	return line.match(/^\s*/)?.[0].replaceAll("\t", "    ").length ?? 0;
}

function isFence(line) {
	return line.match(/^\s*(`{3,}|~{3,})/)?.[1]?.[0] ?? null;
}

export function parseReviewAnnotations(originalMarkdown, editedMarkdown) {
	const original = normalize(originalMarkdown);
	const edited = normalize(editedMarkdown);
	const lines = edited.split("\n");
	const directives = [];
	const questions = [];
	const ambiguous = [];
	const removed = new Set();
	let fence = null;
	let context = "Plan";

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		const marker = isFence(line);
		if (marker) {
			if (fence === null) fence = marker;
			else if (fence === marker) fence = null;
			continue;
		}
		if (fence !== null) continue;
		const heading = line.match(/^\s*#{1,6}\s+(.+?)\s*$/);
		if (heading) context = heading[1];

		const annotation = line.match(/^(\s*)([!?])(?:\s+|$)(.*)$/);
		if (!annotation) continue;
		const [, leading, kind, firstText] = annotation;
		const continuation = [];
		let cursor = index + 1;
		while (cursor < lines.length) {
			const candidate = lines[cursor];
			if (!candidate.trim()) break;
			if (/^\s*#{1,6}\s/.test(candidate) || /^\s*[!?](?:\s+|$)/.test(candidate)) break;
			if (indentation(candidate) < indentation(leading) + 2) break;
			if (/^\s*[-*+]\s+\*\*(?:Targets|Tools \/ APIs|Ledger):\*\*/.test(candidate)) break;
			continuation.push(candidate.trim());
			removed.add(cursor);
			cursor += 1;
		}
		removed.add(index);
		const text = [firstText.trim(), ...continuation].filter(Boolean).join("\n");
		const isAmbiguous = text.length === 0;
		const item = { kind: isAmbiguous ? "?" : kind, originalKind: kind, text, context, line: index + 1, ambiguous: isAmbiguous };
		if (item.ambiguous) ambiguous.push(item);
		if (item.kind === "!") directives.push(item);
		else questions.push(item);
	}

	const cleanedMarkdown = lines.filter((_line, index) => !removed.has(index)).join("\n").trimEnd();
	const contextsWithDirectives = new Set(directives.map((item) => item.context));
	const conflicts = questions
		.filter((item) => contextsWithDirectives.has(item.context))
		.map((item) => ({ context: item.context, question: item.text }));
	return {
		directives,
		questions,
		ambiguous,
		conflicts,
		cleanedMarkdown,
		hasAnnotations: directives.length + questions.length > 0,
		hasDirectEdits: cleanedMarkdown !== original,
		changed: edited !== original,
	};
}
