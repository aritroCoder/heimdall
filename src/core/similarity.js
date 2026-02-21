
"use strict";

function jaccardSimilarity(setA, setB, emptySimilarity = 1) {
  if (setA.size === 0 && setB.size === 0) {
    return emptySimilarity;
  }

  let intersection = 0;
  for (const value of setA) {
    if (setB.has(value)) {
      intersection += 1;
    }
  }

  const union = setA.size + setB.size - intersection;
  if (union === 0) {
    return 0;
  }

  return intersection / union;
}

function cosineSimilarityFromMaps(mapA, mapB) {
  if (mapA.size === 0 || mapB.size === 0) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (const value of mapA.values()) {
    normA += value * value;
  }

  for (const value of mapB.values()) {
    normB += value * value;
  }

  const [smaller, larger] = mapA.size <= mapB.size ? [mapA, mapB] : [mapB, mapA];
  for (const [token, value] of smaller.entries()) {
    if (larger.has(token)) {
      dot += value * larger.get(token);
    }
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function cosineSimilarityFromVectors(vectorA, vectorB) {
  if (vectorA.length === 0 || vectorB.length === 0 || vectorA.length !== vectorB.length) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let index = 0; index < vectorA.length; index += 1) {
    const a = vectorA[index];
    const b = vectorB[index];
    dot += a * b;
    normA += a * a;
    normB += b * b;
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

module.exports = {
  cosineSimilarityFromMaps,
  cosineSimilarityFromVectors,
  jaccardSimilarity,
};
