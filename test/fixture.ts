// A small, made-up profile and record for the tests. No real person's data.

import type { Mirror } from "../src/mirror.ts";
import { parseRecord } from "../src/record.ts";

export const mirror = (over: Partial<Mirror> = {}): Mirror => ({
	name: "Ada Example",
	headline: "Engineer of examples",
	vanityName: "ada-example",
	profileUrn: "urn:li:fsd_profile:EXAMPLE",
	exportedAt: new Date().toISOString(),
	sections: {
		About: "I write examples.",
		Experience: [
			{
				title: "Engineer",
				subtitle: "Acme Corp · Full-time",
				dates: "Mar 2020 - Present · 5 yrs",
				description: "Built things.",
			},
			{
				title: "Globex",
				subtitle: "Full-time · 3 yrs",
				roles: [
					{
						title: "Senior Engineer",
						dates: "Jan 2018 - Feb 2020",
						description: "Led things.",
					},
					{
						title: "Engineer",
						dates: "Jan 2016 - Dec 2017",
						description: "Did things.",
					},
				],
			},
		],
		Projects: [
			{
				title: "Widget",
				subtitle: "Mar 2024 - Present",
				description: "A widget.",
			},
		],
		Volunteering: [
			{
				title: "Driver",
				subtitle: "Food Bank",
				dates: "Jan 2019 - Present · 6 yrs",
			},
		],
	},
	entities: {
		positions: [
			{
				id: "1",
				title: "Engineer",
				company: "Acme Corp",
				description: "Built things.",
			},
			{
				id: "2",
				title: "Senior Engineer",
				company: "Globex",
				description: "Led things.",
			},
			{
				id: "3",
				title: "Engineer",
				company: "Globex",
				description: "Did things.",
			},
		],
		educations: [
			{
				id: "10",
				school: "Example University",
				degree: "BSc",
				field: "Physics",
				dates: { start: "2010", end: "2014" },
			},
			{
				id: "11",
				school: "Example University",
				degree: "MSc",
				field: "Physics",
			},
		],
		certifications: [
			{
				id: "20",
				name: "First Aid",
				issuer: "Red Example",
				dates: { start: "2018-03", end: null },
			},
		],
		honors: [
			{
				id: "30",
				title: "Dean's List",
				issuer: "Example University",
				date: "2013-05",
			},
		],
		publications: [
			{
				id: "40",
				title: "On Examples",
				publisher: "Journal of Examples",
				date: "2021-09-01",
			},
		],
		volunteering: [
			{
				id: "50",
				organization: "Food Bank",
				role: "Driver",
				cause: "POVERTY_ALLEVIATION",
			},
		],
		projects: [
			{
				id: "60",
				title: "Widget",
				dates: { start: "2024-03", end: "2024-03" },
			},
		],
		skills: [
			{ id: "70", name: "JavaScript" },
			{ id: "71", name: "PostgreSQL" },
		],
	},
	...over,
});

export const record = (text: string) => parseRecord(text, "test.md");
