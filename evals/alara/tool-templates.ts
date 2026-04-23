import type { ToolSpec } from "../harness/types";

export interface ToolTemplate extends ToolSpec {
  prompts: string[];
}

export const TOOL_TEMPLATES: ToolTemplate[] = [
  // --- Weather / Climate (5) ---
  {
    name: "get_weather",
    description: "Get the current weather conditions for a given city",
    domain: "weather",
    inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    prompts: [
      "What's the weather like in Berlin right now?",
      "Tell me the current weather conditions in Tokyo.",
      "How's the weather in New York today?",
    ],
  },
  {
    name: "get_forecast",
    description: "Get the 5-day weather forecast for a given city",
    domain: "weather",
    inputSchema: { type: "object", properties: { city: { type: "string" }, days: { type: "number" } }, required: ["city"] },
    prompts: [
      "What's the forecast for London this week?",
      "Show me the 5-day forecast for Paris.",
      "Will it rain in Seattle this week?",
    ],
  },
  {
    name: "get_humidity",
    description: "Get the current humidity level for a given city",
    domain: "weather",
    inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    prompts: [
      "What's the humidity in Miami right now?",
      "How humid is it in Singapore today?",
      "Tell me the current humidity level in Bangkok.",
    ],
  },
  {
    name: "get_wind_speed",
    description: "Get the current wind speed and direction for a given city",
    domain: "weather",
    inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    prompts: [
      "How windy is it in Chicago right now?",
      "What's the wind speed in San Francisco?",
      "Tell me the current wind conditions in Denver.",
    ],
  },
  {
    name: "get_uv_index",
    description: "Get the current UV index for a given city",
    domain: "weather",
    inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    prompts: [
      "What's the UV index in Sydney right now?",
      "How strong is the sun in Los Angeles today?",
      "Should I wear sunscreen in Phoenix? What's the UV?",
    ],
  },

  // --- Calendar (5) ---
  {
    name: "create_event",
    description: "Create a new calendar event with a title, date, and time",
    domain: "calendar",
    inputSchema: { type: "object", properties: { title: { type: "string" }, date: { type: "string" }, time: { type: "string" } }, required: ["title", "date"] },
    prompts: [
      "Schedule a meeting called 'Sprint Review' for next Tuesday at 2pm.",
      "Create a calendar event for my dentist appointment on March 5th.",
      "Add 'Team Lunch' to my calendar for Friday at noon.",
    ],
  },
  {
    name: "delete_event",
    description: "Delete an existing calendar event by its ID or title",
    domain: "calendar",
    inputSchema: { type: "object", properties: { event_id: { type: "string" } }, required: ["event_id"] },
    prompts: [
      "Cancel my meeting with Sarah tomorrow.",
      "Remove the 'Sprint Review' event from my calendar.",
      "Delete the dentist appointment I have on Thursday.",
    ],
  },
  {
    name: "list_events",
    description: "List all calendar events for a given date range",
    domain: "calendar",
    inputSchema: { type: "object", properties: { start_date: { type: "string" }, end_date: { type: "string" } }, required: ["start_date"] },
    prompts: [
      "What meetings do I have this week?",
      "Show me my calendar for tomorrow.",
      "List all my events for next Monday.",
    ],
  },
  {
    name: "move_event",
    description: "Reschedule an existing calendar event to a new date and time",
    domain: "calendar",
    inputSchema: { type: "object", properties: { event_id: { type: "string" }, new_date: { type: "string" }, new_time: { type: "string" } }, required: ["event_id", "new_date"] },
    prompts: [
      "Move my 3pm meeting to 4pm.",
      "Reschedule the team sync to next Wednesday.",
      "Push my dentist appointment back by one hour.",
    ],
  },
  {
    name: "get_availability",
    description: "Check availability for a given time slot across calendars",
    domain: "calendar",
    inputSchema: { type: "object", properties: { date: { type: "string" }, time: { type: "string" }, duration_minutes: { type: "number" } }, required: ["date"] },
    prompts: [
      "Am I free on Tuesday at 3pm?",
      "Check if I have any conflicts at 10am tomorrow.",
      "When am I available this Thursday afternoon?",
    ],
  },

  // --- File Operations (5) ---
  {
    name: "read_file",
    description: "Read the contents of a file at the given path",
    domain: "files",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    prompts: [
      "Show me the contents of config.yaml.",
      "Read the file at /tmp/notes.txt.",
      "What's in the README.md file?",
    ],
  },
  {
    name: "write_file",
    description: "Write content to a file at the given path, creating it if needed",
    domain: "files",
    inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
    prompts: [
      "Write 'hello world' to /tmp/test.txt.",
      "Create a new file called notes.md with the heading '# Notes'.",
      "Save this text to output.txt: 'Processing complete.'",
    ],
  },
  {
    name: "delete_file",
    description: "Delete a file at the given path",
    domain: "files",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    prompts: [
      "Delete the file at /tmp/old-data.csv.",
      "Remove output.log from the current directory.",
      "Get rid of the temp.txt file.",
    ],
  },
  {
    name: "copy_file",
    description: "Copy a file from one path to another",
    domain: "files",
    inputSchema: { type: "object", properties: { source: { type: "string" }, destination: { type: "string" } }, required: ["source", "destination"] },
    prompts: [
      "Copy config.yaml to config.yaml.backup.",
      "Make a copy of report.pdf in the archive folder.",
      "Duplicate the data.json file to data-backup.json.",
    ],
  },
  {
    name: "list_directory",
    description: "List all files and directories at the given path",
    domain: "files",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    prompts: [
      "What files are in the current directory?",
      "List everything in /tmp/.",
      "Show me the contents of the src folder.",
    ],
  },

  // --- Communication (5) ---
  {
    name: "send_email",
    description: "Send an email to a recipient with a subject and body",
    domain: "communication",
    inputSchema: { type: "object", properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } }, required: ["to", "subject", "body"] },
    prompts: [
      "Send an email to alice@example.com about the project update.",
      "Email the team a reminder about tomorrow's deadline.",
      "Write and send an email to bob@company.com with subject 'Meeting Notes'.",
    ],
  },
  {
    name: "send_sms",
    description: "Send an SMS text message to a phone number",
    domain: "communication",
    inputSchema: { type: "object", properties: { phone: { type: "string" }, message: { type: "string" } }, required: ["phone", "message"] },
    prompts: [
      "Text +1-555-0123 that I'll be 10 minutes late.",
      "Send an SMS to mom saying 'Happy birthday!'",
      "Message +44-7700-900000 with 'On my way'.",
    ],
  },
  {
    name: "create_channel",
    description: "Create a new messaging channel with a name and optional description",
    domain: "communication",
    inputSchema: { type: "object", properties: { name: { type: "string" }, description: { type: "string" } }, required: ["name"] },
    prompts: [
      "Create a new Slack channel called #project-alpha.",
      "Set up a channel named 'design-review' for the team.",
      "Make a new messaging channel called 'urgent-fixes'.",
    ],
  },
  {
    name: "post_message",
    description: "Post a message to an existing messaging channel",
    domain: "communication",
    inputSchema: { type: "object", properties: { channel: { type: "string" }, message: { type: "string" } }, required: ["channel", "message"] },
    prompts: [
      "Post 'Deploy complete' to the #releases channel.",
      "Send a message to #general saying the server is back up.",
      "Post an update in the #standup channel about today's progress.",
    ],
  },
  {
    name: "list_contacts",
    description: "Search and list contacts matching a name or organization",
    domain: "communication",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    prompts: [
      "Find all contacts from Acme Corp.",
      "Search my contacts for someone named Sarah.",
      "List everyone in my contacts from the engineering team.",
    ],
  },
];

export const DOMAINS = [...new Set(TOOL_TEMPLATES.map((t) => t.domain))];
