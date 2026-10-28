export function setCache(key, value) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('zhiXiGraphCache', 1)
    request.onupgradeneeded = function () {
      const db = request.result
      if (!db.objectStoreNames.contains('graph')) db.createObjectStore('graph')
    }
    request.onsuccess = function () {
      const db = request.result
      const tx = db.transaction('graph', 'readwrite')
      tx.objectStore('graph').put(value, key)
      tx.oncomplete = function () { resolve(true) }
      tx.onerror = reject
    }
    request.onerror = reject
  })
}

export function getCache(key) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('zhiXiGraphCache', 1)
    request.onupgradeneeded = function () {
      const db = request.result
      if (!db.objectStoreNames.contains('graph')) db.createObjectStore('graph')
    }
    request.onsuccess = function () {
      const db = request.result
      const tx = db.transaction('graph', 'readonly')
      const getReq = tx.objectStore('graph').get(key)
      getReq.onsuccess = function () { resolve(getReq.result || null) }
      getReq.onerror = reject
    }
    request.onerror = reject
  })
}
