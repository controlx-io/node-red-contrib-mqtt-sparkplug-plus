/**
 * SQLite Queue Manager for MQTT Sparkplug Plus
 * Handles all database operations for message queuing
 */

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

class SQLiteQueueManager {
    constructor(brokerId) {
        this.brokerId = brokerId;
        this.db = null;
        this.dbInitialized = false;
        this.queueLength = -1;
    }

    /**
     * Initialize SQLite database for queue storage
     * @returns {Promise<object>} Promise that resolves to the database instance
     */
    async initializeDatabase() {
        if (this.dbInitialized && this.db) {
            return this.db;
        }
        if (!this.initPromise) {
            this.initPromise = this.openDatabase();
        }
        return this.initPromise;
    }

    /**
     * Wait until the queue table exists. Queries sent before that fail with
     * "no such table: message_queue" on a new database.
     * @returns {Promise<boolean>} true when the database is ready
     */
    async ready() {
        if (this.dbInitialized) {
            return true;
        }
        if (!this.initPromise) {
            return false;
        }
        try {
            await this.initPromise;
        } catch (err) {
            return false;
        }
        return this.dbInitialized;
    }

    async openDatabase() {
        // Create data directory if it doesn't exist
        var dataDir = path.join(process.cwd(), 'data');
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }

        var dbPath = path.join(dataDir, `mqtt-sparkplug-queue-${this.brokerId}.db`);
        
        return new Promise((resolve, reject) => {
            this.db = new sqlite3.Database(dbPath, (err) => {
                if (err) {
                    return reject(err);
                }
                
                // Create queue table if it doesn't exist
                this.db.run(`CREATE TABLE IF NOT EXISTS message_queue (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    topic TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    qos INTEGER DEFAULT 0,
                    retain BOOLEAN DEFAULT 0,
                    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
                )`, (err) => {
                    if (err) {
                        return reject(err);
                    }
                    this.dbInitialized = true;
                    resolve(this.db);
                });
            });
        });
    }

    /**
     * Get the current queue length for a specific broker
     * @returns {Promise<number>} Promise that resolves to the queue count
     */
    async getQueueLength() {
        if (!this.db || !(await this.ready())) {
            return 0;
        }

        if (this.queueLength === -1) {
          return new Promise((resolve, reject) => {
              this.db.get("SELECT COUNT(*) as count FROM message_queue", (err, row) => {
                  if (err) {
                      reject(err);
                  } else {
                      this.queueLength = row.count;
                      resolve(row.count);
                  }
              });
          });
        } else {
          return this.queueLength;
        }
    }

    /**
     * Add a message to the queue
     * @param {string} topic - The MQTT topic
     * @param {object} payload - The message payload
     * @param {number} qos - Quality of Service level
     * @param {boolean} retain - Whether the message should be retained
     * @returns {Promise<void>}
     */
    async addMessageToQueue(topic, payload, qos = 0, retain = false) {
        if (!this.db || !(await this.ready())) {
            throw new Error("Database not initialized");
        }
        this.queueLength += 1;

        let payloadStr = JSON.stringify(payload);
        return new Promise((resolve, reject) => {
            this.db.run(
                "INSERT INTO message_queue (topic, payload, qos, retain) VALUES (?, ?, ?, ?)",
                [topic, payloadStr, qos, retain ? 1 : 0],
                (err) => {
                    if (err) reject(err);
                    else resolve();
                }
            );
        });
    }

    /**
     * Remove the oldest message from the queue for a specific broker
     * @returns {Promise<void>}
     */
    async removeOldestMessage() {
        if (!this.db) {
            throw new Error("Database not initialized");
        }

        this.queueLength -= 1;

        return new Promise((resolve, reject) => {
            this.db.run("DELETE FROM message_queue WHERE id = (SELECT MIN(id) FROM message_queue)", (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    /**
     * Get messages from the queue for processing
     * @param {number} limit - Maximum number of messages to retrieve
     * @returns {Promise<Array>} Promise that resolves to an array of message objects
     */
    async getMessagesFromQueue(limit = 500) {
        if (!this.db) {
            return [];
        }

        return new Promise((resolve, reject) => {
            this.db.all("SELECT * FROM message_queue LIMIT ?", [limit], (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows);
                }
            });
        });
    }

    /**
     * Remove messages from the queue by their IDs
     * @param {Array<number>} messageIds - Array of message IDs to remove
     * @returns {Promise<void>}
     */
    async removeMessagesFromQueue(messageIds) {
        if (!this.db || messageIds.length === 0) {
            return;
        }

        this.queueLength -= messageIds.length;

        const placeholders = messageIds.map(() => '?').join(',');
        return new Promise((resolve, reject) => {
            this.db.run(`DELETE FROM message_queue WHERE id IN (${placeholders})`, messageIds, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    /**
     * Remove a specific message from the queue
     * @param {number} messageId - The message ID to remove
     * @returns {Promise<void>}
     */
    async removeMessageFromQueue(messageId) {
        if (!this.db) {
            throw new Error("Database not initialized");
        }

        this.queueLength -= 1;

        return new Promise((resolve, reject) => {
            this.db.run("DELETE FROM message_queue WHERE id = ?", [messageId], (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    /**
     * Remove all messages from the queue
     * @returns {Promise<void>}
     */
    async clearQueue() {
        if (!this.db) {
            throw new Error("Database not initialized");
        }

        return new Promise((resolve, reject) => {
            this.db.run("DELETE FROM message_queue", (err) => {
                if (err) reject(err);
                else {
                    this.queueLength = 0;
                    resolve();
                }
            });
        });
    }

    /**
     * Close the database connection
     * @returns {Promise<void>}
     */
    async closeDatabase() {
        if (!this.db) {
            return;
        }

        return new Promise((resolve, reject) => {
            this.db.close((err) => {
                if (err) reject(err);
                else {
                    this.db = null;
                    this.dbInitialized = false;
                    this.initPromise = null;
                    resolve();
                }
            });
        });
    }
}

module.exports = SQLiteQueueManager;
