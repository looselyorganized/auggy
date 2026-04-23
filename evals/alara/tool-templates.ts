import type { ToolSpec } from "../harness/types";

export interface ToolTemplate extends ToolSpec {
  prompts: string[];
}

export const TOOL_TEMPLATES: ToolTemplate[] = [
  // --- Weather / Climate (10) ---
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
  {
    name: "get_air_quality",
    description: "Get the current air quality index (AQI) for a given city",
    domain: "weather",
    inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    prompts: [
      "What's the air quality in Beijing right now?",
      "Is the air safe to breathe in Delhi today?",
      "Tell me the AQI for Mexico City.",
    ],
  },
  {
    name: "get_pollen_count",
    description: "Get the current pollen count and allergy forecast for a given city",
    domain: "weather",
    inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    prompts: [
      "What's the pollen count in Atlanta today?",
      "Is it a bad allergy day in Austin?",
      "How high is the pollen in Nashville right now?",
    ],
  },
  {
    name: "get_dew_point",
    description: "Get the current dew point temperature for a given city",
    domain: "weather",
    inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    prompts: [
      "What's the dew point in Houston right now?",
      "How muggy is it in New Orleans today?",
      "Tell me the dew point temperature in Tampa.",
    ],
  },
  {
    name: "get_sunrise_time",
    description: "Get the sunrise and sunset times for a given city on a given date",
    domain: "weather",
    inputSchema: { type: "object", properties: { city: { type: "string" }, date: { type: "string" } }, required: ["city"] },
    prompts: [
      "When does the sun rise in Anchorage tomorrow?",
      "What time is sunset in Lisbon today?",
      "Tell me the sunrise time for Reykjavik.",
    ],
  },
  {
    name: "get_pressure",
    description: "Get the current atmospheric pressure reading for a given city",
    domain: "weather",
    inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    prompts: [
      "What's the barometric pressure in Denver right now?",
      "Tell me the atmospheric pressure in Zurich.",
      "How high is the pressure in Madrid today?",
    ],
  },

  // --- Calendar (10) ---
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
  {
    name: "set_reminder",
    description: "Set a reminder notification for an upcoming calendar event",
    domain: "calendar",
    inputSchema: { type: "object", properties: { event_id: { type: "string" }, minutes_before: { type: "number" } }, required: ["event_id"] },
    prompts: [
      "Remind me 15 minutes before my next meeting.",
      "Set a 1-hour reminder for the dentist appointment.",
      "Add a notification for tomorrow's standup.",
    ],
  },
  {
    name: "find_meeting_time",
    description: "Find the next available meeting slot that works for all attendees",
    domain: "calendar",
    inputSchema: { type: "object", properties: { attendees: { type: "array", items: { type: "string" } }, duration_minutes: { type: "number" } }, required: ["attendees"] },
    prompts: [
      "Find a time that works for me, Alice, and Bob this week.",
      "When can all three of us meet for 30 minutes?",
      "Schedule a group meeting with the design team.",
    ],
  },
  {
    name: "get_event_details",
    description: "Get full details of a specific calendar event including attendees and location",
    domain: "calendar",
    inputSchema: { type: "object", properties: { event_id: { type: "string" } }, required: ["event_id"] },
    prompts: [
      "What are the details for my 2pm meeting?",
      "Who's attending the Sprint Review?",
      "Where is tomorrow's lunch meeting?",
    ],
  },
  {
    name: "add_attendee",
    description: "Add an attendee to an existing calendar event",
    domain: "calendar",
    inputSchema: { type: "object", properties: { event_id: { type: "string" }, attendee: { type: "string" } }, required: ["event_id", "attendee"] },
    prompts: [
      "Add Charlie to the Sprint Review meeting.",
      "Invite sarah@company.com to tomorrow's sync.",
      "Include the new hire in Friday's onboarding session.",
    ],
  },
  {
    name: "create_recurring_event",
    description: "Create a recurring calendar event that repeats on a schedule",
    domain: "calendar",
    inputSchema: { type: "object", properties: { title: { type: "string" }, start_date: { type: "string" }, frequency: { type: "string" } }, required: ["title", "start_date", "frequency"] },
    prompts: [
      "Set up a weekly standup every Monday at 9am.",
      "Create a recurring 1-on-1 every other Thursday.",
      "Schedule a monthly team retrospective.",
    ],
  },

  // --- File Operations (10) ---
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
  {
    name: "move_file",
    description: "Move or rename a file from one path to another",
    domain: "files",
    inputSchema: { type: "object", properties: { source: { type: "string" }, destination: { type: "string" } }, required: ["source", "destination"] },
    prompts: [
      "Move report.pdf to the archive folder.",
      "Rename old-config.yaml to config.yaml.",
      "Move all logs to /var/archive/.",
    ],
  },
  {
    name: "get_file_info",
    description: "Get metadata about a file including size, permissions, and last modified date",
    domain: "files",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    prompts: [
      "How big is the database.sqlite file?",
      "When was config.yaml last modified?",
      "Show me the file permissions for /etc/hosts.",
    ],
  },
  {
    name: "search_files",
    description: "Search for files matching a name pattern or containing specific text",
    domain: "files",
    inputSchema: { type: "object", properties: { pattern: { type: "string" }, directory: { type: "string" } }, required: ["pattern"] },
    prompts: [
      "Find all .log files in the project.",
      "Search for files containing 'TODO' in src/.",
      "Where are the test files in this repo?",
    ],
  },
  {
    name: "create_directory",
    description: "Create a new directory at the given path, including parent directories",
    domain: "files",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    prompts: [
      "Create a new folder called 'backups'.",
      "Make the directory structure src/components/ui/.",
      "Set up a tmp/exports/ directory.",
    ],
  },
  {
    name: "compress_file",
    description: "Compress a file or directory into a zip or tar archive",
    domain: "files",
    inputSchema: { type: "object", properties: { source: { type: "string" }, output: { type: "string" }, format: { type: "string" } }, required: ["source", "output"] },
    prompts: [
      "Zip up the logs directory.",
      "Create a tar.gz of the src folder.",
      "Compress report.pdf into an archive.",
    ],
  },

  // --- Communication (10) ---
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
  {
    name: "schedule_message",
    description: "Schedule a message to be sent to a channel at a specific time",
    domain: "communication",
    inputSchema: { type: "object", properties: { channel: { type: "string" }, message: { type: "string" }, send_at: { type: "string" } }, required: ["channel", "message", "send_at"] },
    prompts: [
      "Schedule 'Good morning team!' to #general at 9am tomorrow.",
      "Send a reminder to #releases at 5pm Friday.",
      "Queue a message for the standup channel at 8:55am.",
    ],
  },
  {
    name: "get_unread_messages",
    description: "Get unread messages from a messaging channel or direct message thread",
    domain: "communication",
    inputSchema: { type: "object", properties: { channel: { type: "string" } }, required: ["channel"] },
    prompts: [
      "Show me unread messages in #engineering.",
      "Do I have any new DMs?",
      "What did I miss in the #incidents channel?",
    ],
  },
  {
    name: "reply_to_thread",
    description: "Reply to a specific message thread in a channel",
    domain: "communication",
    inputSchema: { type: "object", properties: { thread_id: { type: "string" }, message: { type: "string" } }, required: ["thread_id", "message"] },
    prompts: [
      "Reply to that deploy thread saying 'Confirmed working.'",
      "Add a comment on the bug report thread.",
      "Respond to Alice's question in the design thread.",
    ],
  },
  {
    name: "forward_message",
    description: "Forward a message from one channel or conversation to another",
    domain: "communication",
    inputSchema: { type: "object", properties: { message_id: { type: "string" }, to_channel: { type: "string" } }, required: ["message_id", "to_channel"] },
    prompts: [
      "Forward that error report to #incidents.",
      "Share Alice's message with the #leadership channel.",
      "Send that announcement to #all-hands too.",
    ],
  },
  {
    name: "set_status",
    description: "Set your status message and availability in the messaging platform",
    domain: "communication",
    inputSchema: { type: "object", properties: { status: { type: "string" }, emoji: { type: "string" } }, required: ["status"] },
    prompts: [
      "Set my status to 'In a meeting' for the next hour.",
      "Mark me as away with status 'Back at 3pm'.",
      "Set my Slack status to 'Focusing — DND'.",
    ],
  },
];

export const DOMAINS = [...new Set(TOOL_TEMPLATES.map((t) => t.domain))];
