
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

        // 1. Fetch slots starting soon
        // SQL handles the "now" comparison using UTC_TIMESTAMP()
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

                /**
                 * 2. Modern Unix Conversion
                 * With dateStrings: true, slot.start_time is a string "YYYY-MM-DD HH:mm:ss".
                 * We force Luxon to treat this string as UTC.
                 */
                const unix = Math.floor(DateTime.fromSQL(slot.start_time, { zone: 'utc' }).toSeconds());
                
                // 3. Send the DM with Discord's dynamic timestamps
                await user.send(`🔔 **Reminder:** Your booking #${slot.slot_id} starts at <t:${unix}:t> (<t:${unix}:R>)!`);

                // 4. Mark as sent
                await conn.query("UPDATE booking_slots SET reminder_sent = TRUE WHERE slot_id = ?", [slot.slot_id]);
                
                console.log(`[Reminder] Sent to ${user.username} for slot #${slot.slot_id}`);

            } catch (dmErr) {
                console.warn(`[Reminder] Could not DM user ${slot.booked_by_id}. DMs might be closed.`);
                
                // Mark as sent anyway so the loop doesn't keep retrying a blocked user
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