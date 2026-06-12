import Database from 'better-sqlite3';
import { resolve } from 'path';

const dbPath = resolve('data', 'footbar.db');
const db = new Database(dbPath);

try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    console.log('Tables:', tables.map(t => t.name).join(', '));
    
    const usersTable = tables.find(t => t.name === 'users');
    if (usersTable) {
        const userCount = db.prepare("SELECT COUNT(*) as c FROM users").get();
        console.log('User count:', userCount.c);
        
        if (userCount.c > 0) {
            const users = db.prepare("SELECT id, email FROM users").all();
            console.log('Users:', users);
        }
    } else {
        console.log('Users table NOT FOUND');
    }
} catch (e) {
    console.error('Error:', e.message);
}
