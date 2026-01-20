const chalk = require('chalk');
const { marked } = require('marked');
const TerminalRenderer = require('marked-terminal').default || require('marked-terminal');

marked.setOptions({
  renderer: new TerminalRenderer({
    width: process.stdout.columns || 80,
    reflowText: true,
    showSectionPrefix: false,
  })
});

const textToSimulate = `Since JavaScript is used for everything from website interactivity to server-side applications, the "best" examples depend on what you're looking to do.

Here are three foundational examples covering the basics, modern data handling, and DOM manipulation.

### 1. The Basics: Functions and Template Literals

This snippet shows how to define a function, use variables, and print a formatted string to the console.

\`\`\`javascript
// A simple greeting function
function greetUser(name, timeOfDay) {
  return \`Good \${timeOfDay}, \${name}! Welcome to the project.\`;
}

const message = greetUser("Alex", "morning");
console.log(message); 
// Output: Good morning, Alex! Welcome to the project.
\`\`\`
`;

let fullText = '';
let lastRenderedLinesCount = 0;

// Regex to strip ANSI codes for accurate length calculation
const ansiRegex = /[][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
function stripAnsi(str) {
    return str.replace(ansiRegex, '');
}

function clearLines(count) {
    if (count > 0) {
        process.stdout.moveCursor(0, -count);
        process.stdout.clearScreenDown();
    }
}

function calculateVisualLines(text) {
    const columns = process.stdout.columns || 80;
    const lines = text.split('\n');
    let visualLineCount = 0;
    
    for (const line of lines) {
        const cleanLine = stripAnsi(line);
        const rows = Math.max(1, Math.ceil(cleanLine.length / columns));
        visualLineCount += rows;
    }
    return visualLineCount;
}

function renderMarkdown() {
    let textToRender = fullText;
    const codeBlockMatches = fullText.match(/^```/gm);
    if (codeBlockMatches && codeBlockMatches.length % 2 !== 0) {
        textToRender += '\n```';
    }

    const rendered = marked(textToRender).trim(); 
    
    // Clear
    clearLines(lastRenderedLinesCount);
    
    // Write
    process.stdout.write(rendered);
    
    // Calculate new
    lastRenderedLinesCount = calculateVisualLines(rendered);
}

// Simulate typing
const chars = textToSimulate.split('');
let index = 0;

console.log(chalk.green('You > send me js code\n'));
console.log(chalk.yellow('Gemini is typing...'));

function type() {
    if (index >= chars.length) {
        process.stdout.write('\n');
        return;
    }
    
    fullText += chars[index];
    index++;
    
    renderMarkdown();
    
    setTimeout(type, 10); // Fast typing
}

type();

