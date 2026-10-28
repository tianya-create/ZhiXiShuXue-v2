function levenshtein(a, b) {
  const s = String(a || '');
  const t = String(b || '');
  const rows = s.length + 1;
  const cols = t.length + 1;
  const dp = Array.from({ length: rows }, () => Array(cols).fill(0));

  for (let i = 0; i < rows; i += 1) dp[i][0] = i;
  for (let j = 0; j < cols; j += 1) dp[0][j] = j;

  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }

  return dp[s.length][t.length];
}

function similarity(a, b) {
  const s = String(a || '').trim();
  const t = String(b || '').trim();
  if (!s && !t) return 1;
  const maxLen = Math.max(s.length, t.length, 1);
  return 1 - levenshtein(s, t) / maxLen;
}

function looksLikeRegex(pattern) {
  const text = String(pattern || '').trim();
  if (!text) return false;
  return text.startsWith('^') || text.endsWith('$') || /\\d|\\s|\\w|\[.*\]|\(.*\)|\|/.test(text);
}

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function getOptionLabel(index) {
  return String.fromCharCode(65 + index);
}

function normalizeChoiceAnswer(question, rawAnswer) {
  const answerText = String(rawAnswer || '').trim();
  const normalizedAnswer = normalizeText(answerText);
  const options = Array.isArray(question.options) ? question.options : [];

  if (!normalizedAnswer) {
    return {
      raw: answerText,
      normalized: '',
      label: '',
      content: ''
    };
  }

  const optionIndexByLabel = options.findIndex((_option, index) => normalizeText(getOptionLabel(index)) === normalizedAnswer);
  if (optionIndexByLabel >= 0) {
    return {
      raw: answerText,
      normalized: normalizeText(getOptionLabel(optionIndexByLabel)),
      label: getOptionLabel(optionIndexByLabel),
      content: options[optionIndexByLabel]
    };
  }

  const optionIndexByContent = options.findIndex(option => normalizeText(option) === normalizedAnswer);
  if (optionIndexByContent >= 0) {
    return {
      raw: answerText,
      normalized: normalizeText(getOptionLabel(optionIndexByContent)),
      label: getOptionLabel(optionIndexByContent),
      content: options[optionIndexByContent]
    };
  }

  return {
    raw: answerText,
    normalized: normalizedAnswer,
    label: answerText.toUpperCase(),
    content: answerText
  };
}

function buildChoiceDisplay(question, rawAnswer) {
  const info = normalizeChoiceAnswer(question, rawAnswer);
  if (!info.normalized) return '-';
  if (info.label && info.content) return `${info.label}（${info.content}）`;
  return info.content || info.label || '-';
}

function gradeAnswer(question, userAnswer) {
  const type = question.type === 'shortAnswer' ? 'subjective' : question.type;
  const normalizedUserAnswer = String(userAnswer || '').trim();
  const correctAnswer = String(question.answer_text || question.answerText || question.answer || '').trim();

  if (type === 'choice') {
    const normalizedUser = normalizeChoiceAnswer(question, normalizedUserAnswer);
    const normalizedStandard = normalizeChoiceAnswer(question, correctAnswer);
    const isCorrect = !!normalizedUser.normalized && normalizedUser.normalized === normalizedStandard.normalized;
    return {
      isCorrect,
      correctAnswer: buildChoiceDisplay(question, correctAnswer),
      explanation: question.explanation || question.analysis || '',
      userAnswer: normalizedUserAnswer,
      similarity: isCorrect ? 1 : 0
    };
  }

  if (type !== 'subjective') {
    const isCorrect = normalizeText(normalizedUserAnswer) === normalizeText(correctAnswer);
    return {
      isCorrect,
      correctAnswer,
      explanation: question.explanation || question.analysis || '',
      userAnswer: normalizedUserAnswer,
      similarity: isCorrect ? 1 : 0
    };
  }

  let isCorrect = false;
  let score = 0;
  if (looksLikeRegex(correctAnswer)) {
    isCorrect = new RegExp(correctAnswer).test(normalizedUserAnswer);
    score = isCorrect ? 1 : 0;
  } else {
    score = similarity(normalizedUserAnswer, correctAnswer);
    isCorrect = score >= 0.8;
  }

  return {
    isCorrect,
    correctAnswer,
    explanation: question.explanation || question.analysis || '',
    userAnswer: normalizedUserAnswer,
    similarity: score
  };
}

module.exports = {
  levenshtein,
  similarity,
  looksLikeRegex,
  normalizeChoiceAnswer,
  buildChoiceDisplay,
  gradeAnswer
};
