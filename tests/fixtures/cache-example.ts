import { JsonObject } from "@/lib/airtable-cache/types";

export const EXAMPLE_SITE_KEY = "influence.centercentre.com";

export const EXAMPLE_TOPICS_URL =
  "https://api.airtable.com/v0/appHcZTzlfXAJpL7I/tblPK86FOTzKTDnkY?";

export const EXAMPLE_PUBLISHED_DATES_URL =
  "https://api.airtable.com/v0/appHcZTzlfXAJpL7I/tblVtIK7hg8LOJfZd?sort%5B0%5D%5Bfield%5D=Date&sort%5B0%5D%5Bdirection%5D=asc&fields%5B%5D=Date&fields%5B%5D=Cohort&filterByFormula=%7BPublished%7D+%3D+%27Published%27";

export const EXAMPLE_FILTERED_LABS_URL =
  "https://api.airtable.com/v0/appHcZTzlfXAJpL7I/tblVtIK7hg8LOJfZd?filterByFormula=AND%28OR%28FIND%28%27April+2026%27%2C+ARRAYJOIN%28%7BCohort%7D%2C+%27%2C%27%29%29+%3E+0%2C+%7BCohort%7D+%3D+%27April+2026%27%2CFIND%28%27May+2026%27%2C+ARRAYJOIN%28%7BCohort%7D%2C+%27%2C%27%29%29+%3E+0%2C+%7BCohort%7D+%3D+%27May+2026%27%2CFIND%28%27June+2026%27%2C+ARRAYJOIN%28%7BCohort%7D%2C+%27%2C%27%29%29+%3E+0%2C+%7BCohort%7D+%3D+%27June+2026%27%29%2C+%7BPublished%7D+%3D+%27Published%27%29";

export const EXAMPLE_TOPICS_RECORDS: JsonObject[] = [
  {
    id: "rec3tqBB57yFlkf2L",
    createdTime: "2025-03-19T20:21:40.000Z",
    fields: {
      Name: "Pillar 2",
      Description:
        "You and your stakeholders are finally on the same page. You have conversations, not disagreements around which efforts will best improve your products and services.",
      Calendar: [
        "recUlxiX79lcOOvBQ",
        "recNpoUIUfOkrBl8i",
        "recMW0p2r7cp7sabc",
        "rec3M0iZ8DdKe5R0P",
      ],
      Title: "Establish UX Outcomes & Visions",
      "Lecture Link":
        "https://leaders.centercentre.com/posts/win-stakeholders-influence-decisions-watch-pillar-2-establish-ux-outcomes-visions",
      "Session Recordings":
        "https://leaders.centercentre.com/posts/win-stakeholders-influence-decisions-september-2025-cohort-live-lab-recordings-89846770",
      "First Homework":
        "Your assignment for this coming week is to **identify your stakeholder's priorities.**",
      "Second Homework":
        "Your homework for next week is to **translate your stakeholder's top priorities into UX outcomes.**",
      "First Homework Link":
        "https://leaders.centercentre.com/posts/win-stakeholders-influence-decisions-pillar-2-homework-to-prepare-for-lab-1 ",
      "Second Homework Link":
        "https://leaders.centercentre.com/posts/win-stakeholders-influence-decisions-pillar-2-homework-to-prepare-for-lab-1 ",
    },
  },
  {
    id: "recSm1h64Fu2md21X",
    createdTime: "2025-03-19T20:21:40.000Z",
    fields: {
      Name: "Pillar 3",
      Description:
        "You no longer feel like you’re selling the team on the importance of UX. You’re having meaningful conversations that influence product ideas and create natural buy-in for your initiatives.",
      Calendar: [
        "rec8fYHjmH5ASBW6u",
        "rect43tsWMym2codv",
        "recp41mlurGQBQBH1",
      ],
      Title: "Build Strong Connection Skills",
      "Lecture Link":
        "https://leaders.centercentre.com/posts/win-stakeholders-influence-decisions-watch-pillar-3-recording-build-strong-connection-skills",
      "Session Recordings":
        "https://leaders.centercentre.com/posts/win-stakeholders-influence-decisions-catch-up-pillar-3-live-lab-recordings",
    },
  },
];

export const EXAMPLE_PUBLISHED_DATE_RECORDS: JsonObject[] = [
  {
    id: "recpGLUbKstvA9a7M",
    createdTime: "2025-12-03T13:41:46.000Z",
    fields: {
      Date: "2026-04-15T15:00:00.000Z",
      Cohort: ["Late-March 2026"],
    },
  },
  {
    id: "recVp9W668BCRb7n3",
    createdTime: "2025-08-02T16:25:12.000Z",
    fields: {
      Date: "2026-04-15T17:00:00.000Z",
      Cohort: ["January 2026"],
    },
  },
  {
    id: "rec0kecsFCvqKgw0C",
    createdTime: "2025-04-11T20:07:30.000Z",
    fields: {
      Date: "2025-05-13T18:00:00.000Z",
      Cohort: ["January 2025"],
      "Event Link": "https://leaders.centercentre.com/events/january-cohort-wrap-up",
      "Session Type": "Wrap Up",
      "Session Name": " Wrap Up",
    },
  },
];

export const EXAMPLE_FILTERED_LAB_RECORDS: JsonObject[] = [
  {
    id: "rec0C4OMf3K9FukxI",
    createdTime: "2026-03-13T18:32:47.000Z",
    fields: {
      Date: "2026-06-17T23:30:00.000Z",
      Topic: ["rechnY5zVdmzchEFc"],
      Cohort: ["April 2026"],
      "Name (from Topic)": ["Pillar 4"],
      "Description (from Topic)": [
        "You no longer feel like you’re fighting your organization. You’ve uncovered common ground and you and other team leads have identified opportunities where you can work together.",
      ],
      "Title (from Topic)": ["Navigate Product & Development Politics"],
      "Event Link":
        "https://leaders.centercentre.com/events/pillar-4-lab-2-navigate-product-development-politics-94189026",
      "Session Recordings (from Topic)": [
        "https://leaders.centercentre.com/posts/win-stakeholders-influence-decisions-catch-up-pillar-4-live-lab-recordings",
      ],
      "Session Type": "Live Lab 2",
      "Session Name": "Pillar 4 Live Lab 2",
      "Lecture Link (from Topic)": [
        "https://leaders.centercentre.com/posts/win-stakeholders-influence-decisions-watch-pillar-4-recording-navigate-product-development-politics",
      ],
      Published: "Published",
    },
  },
  {
    id: "rec0LI0KCMCKdQfWV",
    createdTime: "2026-03-16T19:04:43.000Z",
    fields: {
      Date: "2026-07-29T17:00:00.000Z",
      Topic: ["reco2PpqmkG4oumm7"],
      Cohort: ["April 2026"],
      "Name (from Topic)": ["Pillar 7"],
      "Description (from Topic)": [
        "Others in the organization come to you and see you as their champion. Not only highlighting you as a leader but also championing your agendas and priorities.",
      ],
      "Title (from Topic)": ["Growing a Practice of Servant Leadership"],
      "Event Link":
        "https://leaders.centercentre.com/events/pillar-7-lab-2-growing-a-practice-of-servant-leadership-99387713",
      "Session Recordings (from Topic)": [
        "https://leaders.centercentre.com/posts/win-stakeholders-influence-decisions-catch-up-pillar-7-live-lab-recordings",
      ],
      "Session Type": "Live Lab 2",
      "Session Name": "Pillar 7 Live Lab 2",
      Published: "Published",
    },
  },
];

export const EXAMPLE_TOPICS_BODY: JsonObject = {
  records: EXAMPLE_TOPICS_RECORDS,
};

export const EXAMPLE_PUBLISHED_DATES_BODY: JsonObject = {
  records: EXAMPLE_PUBLISHED_DATE_RECORDS,
};

export const EXAMPLE_FILTERED_LABS_BODY: JsonObject = {
  records: EXAMPLE_FILTERED_LAB_RECORDS,
};

export const EXAMPLE_PAGINATED_PAGE_ONE: JsonObject = {
  records: EXAMPLE_PUBLISHED_DATE_RECORDS.slice(0, 2),
  offset: "itrExamplePublished/rec0kecsFCvqKgw0C",
};

export const EXAMPLE_PAGINATED_PAGE_TWO: JsonObject = {
  records: EXAMPLE_PUBLISHED_DATE_RECORDS.slice(2),
};
