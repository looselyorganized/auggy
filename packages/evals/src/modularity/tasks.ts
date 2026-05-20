import { mulberry32, pickRandom } from "../harness/rng";
import type { EvalTask } from "../harness/types";

const WEB_FETCH_PROMPTS = [
  "Fetch https://example.com and tell me what the page is about.",
  "What's on the homepage of https://httpbin.org?",
  "Get the contents of https://example.org and summarize it.",
  "Can you fetch https://jsonplaceholder.typicode.com/posts/1 and show me the result?",
  "Read the page at https://example.com/about and tell me what it says.",
  "Retrieve https://httpbin.org/json and show me the data.",
  "I need you to fetch https://example.com and extract the main heading.",
  "Go to https://jsonplaceholder.typicode.com/users/1 and tell me the user's name.",
  "Pull up https://httpbin.org/headers and show me what headers were sent.",
  "Fetch https://example.org and give me a one-sentence summary.",
  "What does https://jsonplaceholder.typicode.com/todos/1 return?",
  "Can you grab the content from https://example.com and list the links on the page?",
  "Read https://httpbin.org/ip and tell me the IP address.",
  "Fetch https://jsonplaceholder.typicode.com/comments/1 and summarize the comment.",
  "What information is at https://example.org?",
  "Get https://httpbin.org/user-agent and tell me what user agent was used.",
  "Fetch the page at https://example.com and count how many paragraphs it has.",
  "Retrieve https://jsonplaceholder.typicode.com/albums/1 and show me the album title.",
  "Pull the content from https://httpbin.org/robots.txt and tell me what it says.",
  "What's the response from https://jsonplaceholder.typicode.com/posts/2?",
];

export function generateModularityTasks(seed: number, count: number): EvalTask[] {
  const rng = mulberry32(seed);
  const tasks: EvalTask[] = [];

  for (let i = 0; i < count; i++) {
    const prompt = pickRandom(WEB_FETCH_PROMPTS, rng);
    tasks.push({
      id: `modularity-${seed}-${i}`,
      prompt,
      expectedTool: "web_fetch",
      catalogSize: 0,
      seed,
      catalogTools: [],
      toolSpecs: [],
    });
  }

  return tasks;
}
