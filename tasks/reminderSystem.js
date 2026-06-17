const { DateTime } = require('luxon');
const pool = require('../database/pool');

async function checkReminders(client) {
    let conn;
    try {
        conn = await pool.getConnection();

        // Auto-close expired slots
        try {
            const result = await conn.query(
                'UPDATE booking_slots SET is_available = FALSE WHERE start_time < NOW() AND is_available = TRUE'
            );
            if (result.affectedRows > 0) {
                console.log(`[Maintenance] Auto-closed ${result.affectedRows} expired slots.`);
            }
        } catch (mErr) {
            console.warn('[Maintenance] Auto-close update skipped:', mErr.message);
        }

        // --- 24-HOUR REMINDER ---
        const upcoming24h = await conn.query(`
            SELECT slot_id, booked_by_id, start_time 
            FROM booking_slots 
            WHERE is_available = FALSE 
            AND reminder_24h_sent = FALSE 
            AND start_time <= DATE_ADD(UTC_TIMESTAMP(), INTERVAL 24 HOUR)
            AND start_time >= DATE_ADD(UTC_TIMESTAMP(), INTERVAL 23 HOUR)
        `);

        for (const slot of upcoming24h) {
            try {
                const user = await client.users.fetch(slot.booked_by_id);
                const unix = Math.floor(DateTime.fromSQL(slot.start_time, { zone: 'utc' }).toSeconds());

                await user.send(`📅 **24-Hour Notice:** Your booking #${slot.slot_id} is tomorrow at <t:${unix}:F> (<t:${unix}:R>)!`);
                await conn.query("UPDATE booking_slots SET reminder_24h_sent = TRUE WHERE slot_id = ?", [slot.slot_id]);

                console.log(`[Reminder-24h] Sent to ${user.username} for slot #${slot.slot_id}`);
            } catch (dmErr) {
                console.warn(`[Reminder-24h] Could not DM user ${slot.booked_by_id}. DMs might be closed.`);
                await conn.query("UPDATE booking_slots SET reminder_24h_sent = TRUE WHERE slot_id = ?", [slot.slot_id]);
            }
        }

        // --- 20-MINUTE REMINDER ---
        const upcoming = await conn.query(`
            SELECT slot_id, booked_by_id, start_time 
            FROM booking_slots 
            WHERE is_available = FALSE 
            AND reminder_sent = FALSE 
            AND start_time <= DATE_ADD(UTC_TIMESTAMP(), INTERVAL 20 MINUTE)
            AND start_time >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 5 MINUTE)
        `);

        for (const slot of upcoming) {
            try {
                const user = await client.users.fetch(slot.booked_by_id);
                const unix = Math.floor(DateTime.fromSQL(slot.start_time, { zone: 'utc' }).toSeconds());

                await user.send(`🔔 **Reminder:** Your booking #${slot.slot_id} starts at <t:${unix}:t> (<t:${unix}:R>)!`);
                await conn.query("UPDATE booking_slots SET reminder_sent = TRUE WHERE slot_id = ?", [slot.slot_id]);

                console.log(`[Reminder] Sent to ${user.username} for slot #${slot.slot_id}`);
            } catch (dmErr) {
                console.warn(`[Reminder] Could not DM user ${slot.booked_by_id}. DMs might be closed.`);
                await conn.query("UPDATE booking_slots SET reminder_sent = TRUE WHERE slot_id = ?", [slot.slot_id]);
            }
        }

    } catch (err) {
        console.error('Maintenance Task Error:', err);
    } finally {
        if (conn) conn.release();
    }
}

module.exports = { checkReminders };