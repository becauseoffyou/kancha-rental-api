const express = require("express");
const pool = require("../config/database");
const authMiddleware = require("../middleware/auth.middleware");
const router = express.Router();


// =========================================
// POST CREATE BOOKING
// =========================================
router.post(
    "/",
    authMiddleware,
    async (req, res) => {
        const client = await pool.connect();

        try {
            const user_id = req.user.userId;
            const {
                equipment_id,
                start_date,
                end_date,
                pickup_method,
                delivery_address,
                delivery_latitude,
                delivery_longitude,
                delivery_distance_km,
                notes,
                payment_type,
            } = req.body;
            if (
                !equipment_id ||
                !start_date ||
                !end_date ||
                !pickup_method ||
                !payment_type
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Data booking belum lengkap",
                });
            }

            if (start_date > end_date) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Tanggal selesai tidak boleh sebelum tanggal mulai",
                });
            }

            if (
                !["PICKUP", "DELIVERY"].includes(
                    pickup_method
                )
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Metode pengambilan tidak valid",
                });
            }

            if (
                !["DP", "FULL"].includes(
                    payment_type
                )
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Tipe pembayaran tidak valid",
                });
            }

            if (
                pickup_method === "DELIVERY" &&
                !delivery_address
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Alamat delivery wajib diisi",
                });
            }

            await client.query("BEGIN");

            // ==============================
            // CEK USER
            // ==============================
            const userResult = await client.query(
                `
    SELECT
        id,
        name,
        email,
        verification_status
    FROM users
    WHERE id = $1
    `,
                [user_id]
            );

            if (userResult.rows.length === 0) {
                await client.query("ROLLBACK");

                return res.status(404).json({
                    success: false,
                    message: "User tidak ditemukan",
                });
            }

            const currentUser = userResult.rows[0];

            if (currentUser.verification_status !== "VERIFIED") {
                await client.query("ROLLBACK");

                return res.status(403).json({
                    success: false,
                    message:
                        "Akun harus terverifikasi sebelum melakukan booking",
                });
            }

            // ==============================
            // CEK EQUIPMENT
            // ==============================
            const equipmentResult =
                await client.query(
                    `
                SELECT
                    id,
                    name,
                    price_per_day,
                    is_active
                FROM equipment
                WHERE id = $1
                  AND is_active = TRUE
                `,
                    [equipment_id]
                );

            if (
                equipmentResult.rows.length === 0
            ) {
                await client.query("ROLLBACK");

                return res.status(404).json({
                    success: false,
                    message:
                        "Equipment tidak ditemukan",
                });
            }

            const equipment =
                equipmentResult.rows[0];

            // ==============================
            // HITUNG TOTAL UNIT
            // ==============================
            const unitResult =
                await client.query(
                    `
                SELECT COUNT(*)::int AS total_units
                FROM equipment_units
                WHERE equipment_id = $1
                  AND status != 'MAINTENANCE'
                `,
                    [equipment_id]
                );

            const totalUnits =
                unitResult.rows[0]?.total_units || 0;

            // ==============================
            // HITUNG UNIT YANG SUDAH BOOKING
            // ==============================
            const bookedResult =
                await client.query(
                    `
                SELECT
                    COALESCE(
                        SUM(bi.quantity),
                        0
                    )::int AS booked_units

                FROM booking_items bi

                INNER JOIN bookings b
                    ON b.id = bi.booking_id

                WHERE bi.equipment_id = $1

                  AND b.start_date <= $3::date

                  AND b.end_date >= $2::date

                  AND b.rental_status NOT IN (
                      'CANCELLED',
                      'COMPLETED'
                  )
                `,
                    [
                        equipment_id,
                        start_date,
                        end_date,
                    ]
                );

            const bookedUnits =
                bookedResult.rows[0]
                    ?.booked_units || 0;

            const availableUnits =
                totalUnits - bookedUnits;

            if (availableUnits <= 0) {
                await client.query("ROLLBACK");

                return res.status(409).json({
                    success: false,
                    message:
                        "Equipment sudah tidak tersedia pada periode tersebut",
                });
            }

            // ==============================
            // HITUNG DURASI
            // ==============================
            const start = new Date(
                `${start_date}T00:00:00`
            );

            const end = new Date(
                `${end_date}T00:00:00`
            );

            const duration =
                Math.floor(
                    (end - start) /
                    (1000 * 60 * 60 * 24)
                ) + 1;

            const pricePerDay =
                Number(
                    equipment.price_per_day
                );

            const subtotal =
                pricePerDay * duration;

            const distanceKm =
                pickup_method === "DELIVERY"
                    ? Number(delivery_distance_km || 0)
                    : 0;

            const deliveryFee =
                pickup_method === "DELIVERY" &&
                    distanceKm > 0
                    ? Math.max(
                        15000,
                        Math.ceil(distanceKm) * 3000
                    )
                    : 0;
            const grandTotal =
                subtotal + deliveryFee;

            const paymentAmount =
                payment_type === "DP"
                    ? Math.ceil(
                        grandTotal * 0.5
                    )
                    : grandTotal;

            const remainingAmount =
                grandTotal - paymentAmount;

            // ==============================
            // GENERATE ORDER NUMBER
            // ==============================
            const orderNumber =
                `KNC-${Date.now()}`;

            // ==============================
            // INSERT BOOKING
            // ==============================
            const bookingResult =
                await client.query(
                    `
                INSERT INTO bookings (
                    order_number,
                    user_id,
                    start_date,
                    end_date,
                    pickup_method,
                    delivery_address,
                    notes,
                    subtotal,
                    delivery_fee,
                    grand_total,
                    payment_type,
                    rental_status
                )
                VALUES (
                    $1,
                    $2,
                    $3,
                    $4,
                    $5,
                    $6,
                    $7,
                    $8,
                    $9,
                    $10,
                    $11,
                    'PENDING_PAYMENT'
                )
                RETURNING *
                `,
                    [
                        orderNumber,
                        user_id,
                        start_date,
                        end_date,
                        pickup_method,
                        pickup_method ===
                            "DELIVERY"
                            ? delivery_address
                            : null,
                        notes || null,
                        subtotal,
                        deliveryFee,
                        grandTotal,
                        payment_type,
                    ]
                );

            const booking =
                bookingResult.rows[0];

            // ==============================
            // INSERT BOOKING ITEM
            // ==============================
            await client.query(
                `
            INSERT INTO booking_items (
                booking_id,
                equipment_id,
                equipment_name,
                price_per_day,
                quantity,
                duration,
                subtotal
            )
            VALUES (
                $1,
                $2,
                $3,
                $4,
                1,
                $5,
                $6
            )
            `,
                [
                    booking.id,
                    equipment.id,
                    equipment.name,
                    pricePerDay,
                    duration,
                    subtotal,
                ]
            );

            // ==============================
            // INSERT PAYMENT
            // ==============================
            const paymentReference =
                `PAY-${Date.now()}`;

            const paymentResult =
                await client.query(
                    `
                INSERT INTO payments (
                    booking_id,
                    payment_reference,
                    payment_type,
                    amount,
                    payment_status
                )
                VALUES (
                    $1,
                    $2,
                    $3,
                    $4,
                    'PENDING'
                )
                RETURNING *
                `,
                    [
                        booking.id,
                        paymentReference,
                        payment_type,
                        paymentAmount,
                    ]
                );

            await client.query("COMMIT");

            res.status(201).json({
                success: true,
                message:
                    "Booking berhasil dibuat",

                data: {
                    booking: {
                        id: booking.id,

                        order_number:
                            booking.order_number,

                        start_date,
                        end_date,

                        subtotal,
                        delivery_fee:
                            deliveryFee,

                        grand_total:
                            grandTotal,

                        payment_type,

                        rental_status:
                            booking.rental_status,
                    },

                    equipment: {
                        id: equipment.id,
                        name: equipment.name,

                        price_per_day:
                            pricePerDay,

                        duration,
                        quantity: 1,
                    },

                    payment: {
                        id:
                            paymentResult.rows[0]
                                .id,

                        payment_reference:
                            paymentResult.rows[0]
                                .payment_reference,

                        payment_type,

                        amount:
                            paymentAmount,

                        remaining_amount:
                            remainingAmount,

                        payment_status:
                            paymentResult.rows[0]
                                .payment_status,
                    },
                },
            });
        } catch (error) {
            await client.query("ROLLBACK");

            console.error(
                "Create booking error:",
                error
            );

            res.status(500).json({
                success: false,
                message:
                    "Gagal membuat booking",
            });
        } finally {
            client.release();
        }
    });
// ========================================
// CUSTOMER - GET MY BOOKINGS
// ========================================
router.get(
    "/me",
    authMiddleware,
    async (req, res) => {
        try {
            const userId = req.user.userId;

            const result = await pool.query(
                `
                SELECT
                    b.id,
                    b.order_number,

                    TO_CHAR(
                        b.start_date,
                        'YYYY-MM-DD'
                    ) AS start_date,

                    TO_CHAR(
                        b.end_date,
                        'YYYY-MM-DD'
                    ) AS end_date,

                    b.pickup_method,
                    b.grand_total,
                    b.payment_type,
                    b.rental_status,
                    b.created_at,

                    CASE
                        WHEN COALESCE(
                            (
                                SELECT SUM(p.amount)
                                FROM payments p
                                WHERE p.booking_id = b.id
                                  AND p.payment_status = 'PAID'
                            ),
                            0
                        ) >= b.grand_total
                        THEN 'PAID'

                        WHEN EXISTS (
                            SELECT 1
                            FROM payments p
                            WHERE p.booking_id = b.id
                              AND p.payment_status = 'PAID'
                        )
                        THEN 'DP_PAID'

                        WHEN EXISTS (
                            SELECT 1
                            FROM payments p
                            WHERE p.booking_id = b.id
                              AND p.payment_status = 'WAITING_VERIFICATION'
                        )
                        THEN 'WAITING_VERIFICATION'

                        ELSE 'UNPAID'
                    END AS payment_status,

                    COALESCE(
                        json_agg(
                            json_build_object(
                                'id', bi.id,
                                'equipment_id', bi.equipment_id,
                                'equipment_name', bi.equipment_name,
                                'price_per_day', bi.price_per_day,
                                'quantity', bi.quantity,
                                'duration', bi.duration,
                                'subtotal', bi.subtotal
                            )
                            ORDER BY bi.id
                        ) FILTER (
                            WHERE bi.id IS NOT NULL
                        ),
                        '[]'::json
                    ) AS items

                FROM bookings b

                LEFT JOIN booking_items bi
                    ON bi.booking_id = b.id

                WHERE b.user_id = $1

                GROUP BY b.id

                ORDER BY b.created_at DESC
                `,
                [userId]
            );

            res.json({
                success: true,
                data: result.rows.map(
                    (booking) => ({
                        ...booking,
                        grand_total: Number(
                            booking.grand_total
                        ),

                        items:
                            booking.items?.map(
                                (item) => ({
                                    ...item,

                                    price_per_day:
                                        Number(
                                            item.price_per_day
                                        ),

                                    quantity:
                                        Number(
                                            item.quantity
                                        ),

                                    duration:
                                        Number(
                                            item.duration
                                        ),

                                    subtotal:
                                        Number(
                                            item.subtotal
                                        ),
                                })
                            ) || [],
                    })
                ),
            });

        } catch (error) {
            console.error(
                "Get my bookings error:",
                error
            );

            res.status(500).json({
                success: false,
                message:
                    "Gagal mengambil booking",
            });
        }
    }
);
// ========================================
// ADMIN - GET ALL BOOKINGS
// ========================================
router.get("/admin/all", async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                b.id,
                b.order_number,
                b.start_date,
                b.end_date,
                b.pickup_method,
                b.delivery_address,
                b.subtotal,
                b.delivery_fee,
                b.grand_total,
                b.payment_type,
                b.rental_status,
                b.created_at,

                u.id AS user_id,
                u.name AS customer_name,
                u.email AS customer_email,
                u.phone AS customer_phone,

                COALESCE(
                    STRING_AGG(
                        DISTINCT bi.equipment_name,
                        ', '
                    ),
                    '-'
                ) AS equipment_name,

               CASE
    WHEN COALESCE(
        (
            SELECT SUM(p.amount)
            FROM payments p
            WHERE p.booking_id = b.id
              AND p.payment_status = 'PAID'
        ),
        0
    ) >= b.grand_total
    THEN 'PAID'

    WHEN EXISTS (
        SELECT 1
        FROM payments p
        WHERE p.booking_id = b.id
          AND p.payment_status = 'PAID'
    )
    THEN 'PARTIAL'

    WHEN EXISTS (
        SELECT 1
        FROM payments p
        WHERE p.booking_id = b.id
          AND p.payment_status = 'WAITING_VERIFICATION'
    )
    THEN 'WAITING_VERIFICATION'

    ELSE 'PENDING'
END AS payment_status

            FROM bookings b

            INNER JOIN users u
                ON u.id = b.user_id

            LEFT JOIN booking_items bi
                ON bi.booking_id = b.id

            GROUP BY
                b.id,
                u.id,
                u.name,
                u.email,
                u.phone

            ORDER BY b.created_at DESC
        `);

        res.json({
            success: true,

            data: result.rows.map((row) => ({
                ...row,

                subtotal:
                    Number(row.subtotal),

                delivery_fee:
                    Number(row.delivery_fee),

                grand_total:
                    Number(row.grand_total),
            })),
        });

    } catch (error) {
        console.error(
            "Admin get bookings error:",
            error
        );

        res.status(500).json({
            success: false,
            message:
                "Gagal mengambil data booking",
        });
    }
});

// ========================================
// ADMIN - GET BOOKING DETAIL
// ========================================
router.get("/admin/:orderNumber", async (req, res) => {
    try {
        const { orderNumber } = req.params;

        // BOOKING + CUSTOMER
        const bookingResult = await pool.query(
            `
            SELECT
                b.*,
                u.name AS customer_name,
                u.email AS customer_email,
                u.phone AS customer_phone,
                u.verification_status
            FROM bookings b
            INNER JOIN users u
                ON u.id = b.user_id
            WHERE b.order_number = $1
            `,
            [orderNumber]
        );

        if (bookingResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Booking tidak ditemukan",
            });
        }

        const booking = bookingResult.rows[0];

        // BOOKING ITEMS
        const itemsResult = await pool.query(
            `
            SELECT
                bi.id,
                bi.equipment_id,
                bi.equipment_name,
                bi.price_per_day,
                bi.quantity,
                bi.duration,
                bi.subtotal
            FROM booking_items bi
            WHERE bi.booking_id = $1
            ORDER BY bi.id ASC
            `,
            [booking.id]
        );

        // PAYMENT
        const paymentsResult = await pool.query(
            `
            SELECT
                id,
                payment_reference,
                payment_type,
                payment_method,
                bank_code,
                amount,
                payment_status,
                proof_url,
                paid_at,
                created_at
            FROM payments
            WHERE booking_id = $1
            ORDER BY created_at ASC
            `,
            [booking.id]
        );

        // Ambil available + assigned unit untuk setiap item
        const items = [];

        for (const item of itemsResult.rows) {

            // Unit yang SUDAH di-assign
            const assignedResult = await pool.query(
                `
                SELECT
                    eu.id,
                    eu.unit_code,
                    eu.serial_number,
                    eu.status,
                    eu.condition
                FROM booking_item_units biu
                INNER JOIN equipment_units eu
                    ON eu.id = biu.equipment_unit_id
                WHERE biu.booking_item_id = $1
                ORDER BY eu.unit_code ASC
                `,
                [item.id]
            );

            // Unit yang bisa dipilih.
            // Jangan tampilkan unit yang sedang dipakai booking aktif lain
            // dengan tanggal yang bentrok.
            const availableResult = await pool.query(
                `
                SELECT
                    eu.id,
                    eu.unit_code,
                    eu.serial_number,
                    eu.status,
                    eu.condition
                FROM equipment_units eu

                WHERE eu.equipment_id = $1

                AND eu.status != 'MAINTENANCE'

                AND NOT EXISTS (
                    SELECT 1
                    FROM booking_item_units biu2

                    INNER JOIN booking_items bi2
                        ON bi2.id = biu2.booking_item_id

                    INNER JOIN bookings b2
                        ON b2.id = bi2.booking_id

                    WHERE
                        biu2.equipment_unit_id = eu.id

                        AND b2.id != $2

                        AND b2.rental_status NOT IN (
                            'CANCELLED',
                            'COMPLETED'
                        )

                        AND b2.start_date <= $4
                        AND b2.end_date >= $3
                )

                ORDER BY eu.unit_code ASC
                `,
                [
                    item.equipment_id,
                    booking.id,
                    booking.start_date,
                    booking.end_date,
                ]
            );

            items.push({
                ...item,

                price_per_day:
                    Number(item.price_per_day),

                subtotal:
                    Number(item.subtotal),

                assigned_units:
                    assignedResult.rows,

                available_units:
                    availableResult.rows,
            });
        }

        res.json({
            success: true,

            data: {
                ...booking,

                subtotal:
                    Number(booking.subtotal),

                delivery_fee:
                    Number(booking.delivery_fee),

                grand_total:
                    Number(booking.grand_total),

                items,

                payments:
                    paymentsResult.rows.map(
                        (payment) => ({
                            ...payment,

                            amount:
                                Number(
                                    payment.amount
                                ),
                        })
                    ),
            },
        });

    } catch (error) {
        console.error(
            "Admin booking detail error:",
            error
        );

        res.status(500).json({
            success: false,
            message:
                "Gagal mengambil detail booking",
        });
    }
});
// ========================================
// ADMIN - CONFIRM BOOKING + ASSIGN UNITS
// ========================================
router.patch("/admin/:orderNumber/confirm", async (req, res) => {
    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const { orderNumber } = req.params;
        const { assignments } = req.body;

        /*
        assignments:
        [
            {
                booking_item_id: 1,
                equipment_unit_ids: [1]
            }
        ]
        */

        if (!Array.isArray(assignments) || assignments.length === 0) {
            await client.query("ROLLBACK");

            return res.status(400).json({
                success: false,
                message: "Unit equipment wajib dipilih",
            });
        }

        const bookingResult = await client.query(
            `
            SELECT *
            FROM bookings
            WHERE order_number = $1
            FOR UPDATE
            `,
            [orderNumber]
        );

        if (bookingResult.rows.length === 0) {
            await client.query("ROLLBACK");

            return res.status(404).json({
                success: false,
                message: "Booking tidak ditemukan",
            });
        }

        const booking = bookingResult.rows[0];

        if (booking.rental_status !== "WAITING_CONFIRMATION") {
            await client.query("ROLLBACK");

            return res.status(409).json({
                success: false,
                message: "Booking tidak sedang menunggu konfirmasi",
            });
        }

        // Pastikan payment sudah diverifikasi
        const paymentResult = await client.query(
            `
            SELECT id
            FROM payments
            WHERE booking_id = $1
              AND payment_status = 'PAID'
            LIMIT 1
            `,
            [booking.id]
        );

        if (paymentResult.rows.length === 0) {
            await client.query("ROLLBACK");

            return res.status(400).json({
                success: false,
                message: "Pembayaran belum diverifikasi",
            });
        }

        // Ambil seluruh booking item
        const itemsResult = await client.query(
            `
            SELECT
                id,
                equipment_id,
                quantity
            FROM booking_items
            WHERE booking_id = $1
            `,
            [booking.id]
        );

        // Semua item wajib punya assignment
        for (const item of itemsResult.rows) {
            const assignment = assignments.find(
                (a) =>
                    String(a.booking_item_id) ===
                    String(item.id)
            );

            if (!assignment) {
                await client.query("ROLLBACK");

                return res.status(400).json({
                    success: false,
                    message: `Unit untuk booking item ${item.id} belum dipilih`,
                });
            }

            const unitIds = assignment.equipment_unit_ids || [];

            if (unitIds.length !== Number(item.quantity)) {
                await client.query("ROLLBACK");

                return res.status(400).json({
                    success: false,
                    message:
                        `Jumlah unit yang dipilih harus ${item.quantity}`,
                });
            }

            // Jangan sampai ID unit sama dipilih dua kali
            if (new Set(unitIds.map(String)).size !== unitIds.length) {
                await client.query("ROLLBACK");

                return res.status(400).json({
                    success: false,
                    message: "Unit equipment tidak boleh duplikat",
                });
            }

            for (const unitId of unitIds) {

                // Lock unit
                const unitResult = await client.query(
                    `
                    SELECT *
                    FROM equipment_units
                    WHERE id = $1
                      AND equipment_id = $2
                      AND status != 'MAINTENANCE'
                    FOR UPDATE
                    `,
                    [
                        unitId,
                        item.equipment_id,
                    ]
                );

                if (unitResult.rows.length === 0) {
                    await client.query("ROLLBACK");

                    return res.status(409).json({
                        success: false,
                        message: "Unit tidak tersedia",
                    });
                }

                // Cek bentrok booking lain
                const conflictResult = await client.query(
                    `
                    SELECT 1
                    FROM booking_item_units biu

                    INNER JOIN booking_items bi
                        ON bi.id = biu.booking_item_id

                    INNER JOIN bookings b
                        ON b.id = bi.booking_id

                    WHERE biu.equipment_unit_id = $1

                      AND b.id != $2

                      AND b.rental_status NOT IN (
                          'CANCELLED',
                          'COMPLETED'
                      )

                      AND b.start_date <= $4
                      AND b.end_date >= $3

                    LIMIT 1
                    `,
                    [
                        unitId,
                        booking.id,
                        booking.start_date,
                        booking.end_date,
                    ]
                );

                if (conflictResult.rows.length > 0) {
                    await client.query("ROLLBACK");

                    return res.status(409).json({
                        success: false,
                        message:
                            `Unit ${unitResult.rows[0].unit_code} sudah dipakai booking lain pada tanggal tersebut`,
                    });
                }
            }
        }

        // Bersihkan assignment booking ini jika sebelumnya pernah ada
        await client.query(
            `
            DELETE FROM booking_item_units
            WHERE booking_item_id IN (
                SELECT id
                FROM booking_items
                WHERE booking_id = $1
            )
            `,
            [booking.id]
        );

        // Insert assignment
        for (const assignment of assignments) {
            for (const unitId of assignment.equipment_unit_ids) {
                await client.query(
                    `
                    INSERT INTO booking_item_units (
                        booking_item_id,
                        equipment_unit_id
                    )
                    VALUES ($1, $2)
                    `,
                    [
                        assignment.booking_item_id,
                        unitId,
                    ]
                );
            }
        }

        // CONFIRM BOOKING
        await client.query(
            `
            UPDATE bookings
            SET
                rental_status = 'CONFIRMED',
                updated_at = NOW()
            WHERE id = $1
            `,
            [booking.id]
        );

        await client.query("COMMIT");

        res.json({
            success: true,
            message: "Booking berhasil dikonfirmasi",
        });

    } catch (error) {
        await client.query("ROLLBACK");

        console.error(
            "Confirm booking error:",
            error
        );

        res.status(500).json({
            success: false,
            message: "Gagal mengkonfirmasi booking",
        });

    } finally {
        client.release();
    }
});
// =========================================
// GET BOOKING DETAIL BY ORDER NUMBER
// =========================================
router.get("/:orderNumber", async (req, res) => {
    try {
        const { orderNumber } = req.params;

        const bookingResult =
            await pool.query(
                `
                SELECT
                    b.id,
                    b.order_number,
                    b.user_id,

                    TO_CHAR(
                        b.start_date,
                        'YYYY-MM-DD'
                    ) AS start_date,

                    TO_CHAR(
                        b.end_date,
                        'YYYY-MM-DD'
                    ) AS end_date,

                    b.pickup_method,
                    b.delivery_address,
                    b.notes,

                    b.subtotal,
                    b.delivery_fee,
                    b.grand_total,

                    b.payment_type,
                    b.rental_status,

                    b.created_at,

                    u.name AS customer_name,
                    u.email AS customer_email,
                    u.phone AS customer_phone

                FROM bookings b

                INNER JOIN users u
                    ON u.id = b.user_id

                WHERE b.order_number = $1
                `,
                [orderNumber]
            );

        if (
            bookingResult.rows.length === 0
        ) {
            return res.status(404).json({
                success: false,
                message:
                    "Booking tidak ditemukan",
            });
        }

        const booking =
            bookingResult.rows[0];

        // ==============================
        // ITEMS
        // ==============================
        const itemResult =
            await pool.query(
                `
                SELECT
                    bi.id,
                    bi.equipment_id,
                    bi.equipment_name,
                    bi.price_per_day,
                    bi.quantity,
                    bi.duration,
                    bi.subtotal

                FROM booking_items bi

                WHERE bi.booking_id = $1

                ORDER BY bi.id ASC
                `,
                [booking.id]
            );

        // ==============================
        // PAYMENTS
        // ==============================
        const paymentResult =
            await pool.query(
                `
        SELECT
            id,
            payment_reference,
            payment_type,
            payment_method,
            bank_code,
            payment_channel,
            amount,
            payment_status,
            proof_url,
            paid_at,
            created_at,
            updated_at,
            rejection_reason

        FROM payments

        WHERE booking_id = $1

        ORDER BY created_at ASC
        `,
                [booking.id]
            );

        res.json({
            success: true,

            data: {
                booking: {
                    ...booking,

                    subtotal:
                        Number(
                            booking.subtotal
                        ),

                    delivery_fee:
                        Number(
                            booking.delivery_fee
                        ),

                    grand_total:
                        Number(
                            booking.grand_total
                        ),
                },

                items:
                    itemResult.rows.map(
                        (item) => ({
                            ...item,

                            price_per_day:
                                Number(
                                    item.price_per_day
                                ),

                            quantity:
                                Number(
                                    item.quantity
                                ),

                            duration:
                                Number(
                                    item.duration
                                ),

                            subtotal:
                                Number(
                                    item.subtotal
                                ),
                        })
                    ),

                payments:
                    paymentResult.rows.map(
                        (payment) => ({
                            ...payment,

                            amount:
                                Number(
                                    payment.amount
                                ),
                        })
                    ),
            },
        });
    } catch (error) {
        console.error(
            "Get booking detail error:",
            error
        );

        res.status(500).json({
            success: false,
            message:
                "Gagal mengambil detail booking",
        });
    }
});
router.patch(
    "/admin/:orderNumber/ready",
    async (req, res) => {
        try {
            const { orderNumber } =
                req.params;

            const result =
                await pool.query(
                    `
                    UPDATE bookings
                    SET
                        rental_status = 'READY_FOR_PICKUP',
                        updated_at = NOW()
                    WHERE order_number = $1
                      AND rental_status = 'CONFIRMED'
                    RETURNING *
                    `,
                    [orderNumber]
                );

            if (
                result.rows.length === 0
            ) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "Booking tidak dapat diubah menjadi siap diambil",
                    });
            }

            res.json({
                success: true,
                message:
                    "Booking siap diambil",
                data: result.rows[0],
            });

        } catch (error) {
            console.error(
                "Ready booking error:",
                error
            );

            res.status(500).json({
                success: false,
                message:
                    "Gagal mengubah status booking",
            });
        }
    }
);
router.patch(
    "/admin/:orderNumber/handover",
    async (req, res) => {
        const client =
            await pool.connect();

        try {
            await client.query(
                "BEGIN"
            );

            const { orderNumber } =
                req.params;

            const bookingResult =
                await client.query(
                    `
                    SELECT *
                    FROM bookings
                    WHERE order_number = $1
                    FOR UPDATE
                    `,
                    [orderNumber]
                );

            if (
                bookingResult.rows
                    .length === 0
            ) {
                await client.query(
                    "ROLLBACK"
                );

                return res
                    .status(404)
                    .json({
                        success: false,
                        message:
                            "Booking tidak ditemukan",
                    });
            }

            const booking =
                bookingResult.rows[0];

            if (
                booking.rental_status !==
                "READY_FOR_PICKUP"
            ) {
                await client.query(
                    "ROLLBACK"
                );

                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "Booking belum siap diambil",
                    });
            }

            // Hitung semua pembayaran PAID
            const paidResult =
                await client.query(
                    `
                    SELECT
                        COALESCE(
                            SUM(amount),
                            0
                        ) AS total_paid
                    FROM payments
                    WHERE booking_id = $1
                      AND payment_status = 'PAID'
                    `,
                    [booking.id]
                );

            const totalPaid =
                Number(
                    paidResult.rows[0]
                        .total_paid
                );

            const grandTotal =
                Number(
                    booking.grand_total
                );

            if (
                totalPaid <
                grandTotal
            ) {
                await client.query(
                    "ROLLBACK"
                );

                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            `Booking belum lunas. Sisa pembayaran Rp${(
                                grandTotal -
                                totalPaid
                            ).toLocaleString(
                                "id-ID"
                            )}`,
                    });
            }

            // Pastikan unit sudah di-assign
            const unitResult =
                await client.query(
                    `
                    SELECT
                        biu.equipment_unit_id
                    FROM booking_item_units biu
                    INNER JOIN booking_items bi
                        ON bi.id =
                           biu.booking_item_id
                    WHERE bi.booking_id = $1
                    `,
                    [booking.id]
                );

            if (
                unitResult.rows
                    .length === 0
            ) {
                await client.query(
                    "ROLLBACK"
                );

                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "Unit equipment belum di-assign",
                    });
            }

            // Unit fisik jadi RENTED
            await client.query(
                `
                UPDATE equipment_units
                SET status = 'RENTED'
                WHERE id IN (
                    SELECT
                        biu.equipment_unit_id
                    FROM booking_item_units biu
                    INNER JOIN booking_items bi
                        ON bi.id =
                           biu.booking_item_id
                    WHERE bi.booking_id = $1
                )
                `,
                [booking.id]
            );

            // Booking jadi RENTED
            await client.query(
                `
                UPDATE bookings
                SET
                    rental_status = 'RENTED',
                    updated_at = NOW()
                WHERE id = $1
                `,
                [booking.id]
            );

            await client.query(
                "COMMIT"
            );

            res.json({
                success: true,
                message:
                    "Equipment berhasil diserahkan",
            });

        } catch (error) {
            await client.query(
                "ROLLBACK"
            );

            console.error(
                "Handover booking error:",
                error
            );

            res.status(500).json({
                success: false,
                message:
                    "Gagal menyerahkan equipment",
            });

        } finally {
            client.release();
        }
    }
);

router.get("/admin/preparation/count", async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT COUNT(*)::int AS total
            FROM bookings
            WHERE rental_status IN (
                'WAITING_CONFIRMATION',
                'CONFIRMED',
                'READY_FOR_PICKUP'
            )
        `);

        res.json({
            success: true,
            data: {
                total: result.rows[0].total,
            },
        });

    } catch (error) {
        console.error(
            "Preparation booking count error:",
            error
        );

        res.status(500).json({
            success: false,
            message: "Gagal mengambil jumlah booking",
        });
    }
});

module.exports = router;