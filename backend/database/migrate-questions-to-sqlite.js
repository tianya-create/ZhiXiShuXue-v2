const db = require('./memory-db');
const { getAllQuestions, replaceAllQuestions } = require('./question-store');
const { buildPracticeQuestionSeeds } = require('../services/practice-question-seeds');

function main() {
  const existing = db.find('questions');
  const preservedQuestions = existing.filter(question => question.source !== 'practice-seed');
  const rebuiltPracticeSeeds = buildPracticeQuestionSeeds();
  const merged = preservedQuestions.concat(rebuiltPracticeSeeds);

  replaceAllQuestions(merged);
  db.reloadQuestionsFromStore();

  const all = getAllQuestions();
  const bySource = all.reduce((acc, question) => {
    const key = question.source || 'default';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  console.log(JSON.stringify({
    before: existing.length,
    after: all.length,
    rebuiltPracticeSeeds: rebuiltPracticeSeeds.length,
    bySource
  }, null, 2));
}

main();
