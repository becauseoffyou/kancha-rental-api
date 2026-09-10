const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const pool = require("../config/database");
const authMiddleware = require("../middleware/auth.middleware");
const router = express.Router();

const uploadDir = path.join(
    __dirname,
    "../../uploads/payment-proofs"
);

if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, {
        recursive: true,
    });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },

    filename: (req, file, cb) => {
        const ext =
            path.extname(
                file.originalname
            ) || ".jpg";

        const safeReference =
            req.params.paymentReference
                .replace(
                    /[^a-zA-Z0-9-_]/g,
                    ""
                );

        cb(
            null,
            `${safeReference}-${Date.now()}${ext}`
        );
    },
});

const fileFilter = (
    req,
    file,
    cb
) => {
    const allowedTypes = [
        "image/jpeg",
        "image/png",
        "image/webp",
    ];

    if (
        allowedTypes.includes(
            file.mimetype
        )
    ) {
        cb(null, true);
    } else {
        cb(
            new Error(
                "File harus berupa JPG, PNG, atau WEBP"
            ),
            false
        );
    }
};

const upload = multer({
    storage,

    limits: {
        fileSize:
            5 * 1024 * 1024,
    },

    fileFilter,
});

// ========================================
// UPLOAD BUKTI TRANSFER
// ========================================
router.post(
    "/:paymentReference/proof",
    upload.single("proof"),
    async (req, res) => {
        try {
            const {
                paymentReference,
            } = req.params;

            if (!req.file) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "Bukti pembayaran wajib diupload",
                    });
            }

            const paymentResult =
                await pool.query(
                    `
                    SELECT
                        id,
                        payment_status
                    FROM payments
                    WHERE payment_reference = $1
                    `,
                    [
                        paymentReference,
                    ]
                );

            if (
                paymentResult.rows
                    .length === 0
            ) {
                fs.unlinkSync(
                    req.file.path
                );

                return res
                    .status(404)
                    .json({
                        success: false,
                        message:
                            "Pembayaran tidak ditemukan",
                    });
            }

            const proofUrl =
                `/uploads/payment-proofs/${req.file.filename}`;

            const result =
                await pool.query(
                    `
                    UPDATE payments
                    SET
                        proof_url = $1,
                        updated_at = NOW()
                    WHERE payment_reference = $2
                    RETURNING
                        id,
                        payment_reference,
                        proof_url,
                        payment_status
                    `,
                    [
                        proofUrl,
                        paymentReference,
                    ]
                );

            res.json({
                success: true,
                message:
                    "Bukti pembayaran berhasil diupload",
                data:
                    result.rows[0],
            });
        } catch (error) {
            console.error(
                "Upload payment proof error:",
                error
            );

            res.status(500).json({
                success: false,
                message:
                    "Gagal mengupload bukti pembayaran",
            });
        }
    }
);

// ========================================
// ADMIN - GET PAYMENT WAITING VERIFICATION
// ========================================
router.get("/admin/waiting-verification", async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                p.id,
                p.payment_reference,
                p.payment_type,
                p.payment_method,
                p.bank_code,
                p.amount,
                p.payment_status,
                p.proof_url,
                p.created_at,

                b.id AS booking_id,
                b.order_number,
                b.grand_total,
                b.rental_status,
                b.start_date,
                b.end_date,

                u.id AS user_id,
                u.name AS customer_name,
                u.email AS customer_email,
                u.phone AS customer_phone,

                bi.equipment_name

            FROM payments p

            INNER JOIN bookings b
                ON b.id = p.booking_id

            INNER JOIN users u
                ON u.id = b.user_id

            LEFT JOIN booking_items bi
                ON bi.booking_id = b.id

            WHERE p.payment_status = 'WAITING_VERIFICATION'

            ORDER BY p.created_at DESC
        `);

        res.json({
            success: true,
            data: result.rows.map((row) => ({
                ...row,
                amount: Number(row.amount),
                grand_total: Number(row.grand_total),
            })),
        });

    } catch (error) {
        console.error(
            "Get waiting payments error:",
            error
        );

        res.status(500).json({
            success: false,
            message: "Gagal mengambil data pembayaran",
        });
    }
});

// ========================================
// ADMIN - APPROVE PAYMENT
// ========================================
router.patch(
    "/admin/:paymentReference/approve",
    async (req, res) => {
        const client = await pool.connect();

        try {
            await client.query("BEGIN");

            const { paymentReference } = req.params;

            const paymentResult = await client.query(
                `
                SELECT
                    id,
                    booking_id,
                    payment_type,
                    payment_status,
                    amount
                FROM payments
                WHERE payment_reference = $1
                FOR UPDATE
                `,
                [paymentReference]
            );

            if (paymentResult.rows.length === 0) {
                await client.query("ROLLBACK");

                return res.status(404).json({
                    success: false,
                    message: "Pembayaran tidak ditemukan",
                });
            }

            const payment = paymentResult.rows[0];

            if (
                payment.payment_status !==
                "WAITING_VERIFICATION"
            ) {
                await client.query("ROLLBACK");

                return res.status(409).json({
                    success: false,
                    message:
                        "Pembayaran tidak sedang menunggu verifikasi",
                });
            }

            const updatedPayment = await client.query(
                `
                UPDATE payments
                SET
                    payment_status = 'PAID',
                    paid_at = NOW(),
                    rejection_reason = NULL,
                    updated_at = NOW()
                WHERE id = $1
                RETURNING *
                `,
                [payment.id]
            );

            // Booking boleh lanjut setelah pembayaran diverifikasi.
            await client.query(
                `
                UPDATE bookings
                SET
                    rental_status = 'WAITING_CONFIRMATION',
                    updated_at = NOW()
                WHERE id = $1
                `,
                [payment.booking_id]
            );

            await client.query("COMMIT");

            res.json({
                success: true,
                message: "Pembayaran berhasil diverifikasi",
                data: updatedPayment.rows[0],
            });
        } catch (error) {
            await client.query("ROLLBACK");

            console.error(
                "Approve payment error:",
                error
            );

            res.status(500).json({
                success: false,
                message:
                    "Gagal memverifikasi pembayaran",
            });
        } finally {
            client.release();
        }
    }
);

// ========================================
// ADMIN - REJECT PAYMENT
// ========================================
router.patch(
    "/admin/:paymentReference/reject",
    async (req, res) => {
        try {
            const { paymentReference } = req.params;
            const { reason } = req.body;

            if (!reason?.trim()) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Alasan penolakan wajib diisi",
                });
            }

            const result = await pool.query(
                `
                UPDATE payments
                SET
                    payment_status = 'REJECTED',
                    rejection_reason = $1,
                    updated_at = NOW()
                WHERE payment_reference = $2
                  AND payment_status =
                      'WAITING_VERIFICATION'
                RETURNING *
                `,
                [
                    reason.trim(),
                    paymentReference,
                ]
            );

            if (result.rows.length === 0) {
                return res.status(409).json({
                    success: false,
                    message:
                        "Pembayaran tidak ditemukan atau sudah diproses",
                });
            }

            res.json({
                success: true,
                message: "Pembayaran ditolak",
                data: result.rows[0],
            });
        } catch (error) {
            console.error(
                "Reject payment error:",
                error
            );

            res.status(500).json({
                success: false,
                message:
                    "Gagal menolak pembayaran",
            });
        }
    }
);
// ========================================
// CONFIRM PAYMENT
// ========================================
router.patch(
    "/:paymentReference/confirm",
    async (req, res) => {
        try {
            const {
                paymentReference,
            } = req.params;

            const {
                payment_method,
                bank_code,
            } = req.body;

            if (
                ![
                    "TRANSFER",
                    "QRIS",
                ].includes(
                    payment_method
                )
            ) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "Metode pembayaran tidak valid",
                    });
            }

            const paymentResult =
                await pool.query(
                    `
                    SELECT
                        id,
                        booking_id,
                        payment_reference,
                        payment_status,
                        proof_url
                    FROM payments
                    WHERE payment_reference = $1
                    `,
                    [
                        paymentReference,
                    ]
                );

            if (
                paymentResult.rows
                    .length === 0
            ) {
                return res
                    .status(404)
                    .json({
                        success: false,
                        message:
                            "Pembayaran tidak ditemukan",
                    });
            }

            const payment =
                paymentResult.rows[0];

            if (
                payment.payment_status !==
                "PENDING"
            ) {
                return res
                    .status(409)
                    .json({
                        success: false,
                        message:
                            "Pembayaran sudah pernah dikonfirmasi",
                    });
            }

            if (
                payment_method ===
                "TRANSFER" &&
                !payment.proof_url
            ) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "Upload bukti transfer terlebih dahulu",
                    });
            }

            const result =
                await pool.query(
                    `
                    UPDATE payments
                    SET
                        payment_method = $1,
                        bank_code = $2,
                        payment_status =
                            'WAITING_VERIFICATION',
                        updated_at = NOW()
                    WHERE payment_reference = $3
                    RETURNING
                        id,
                        booking_id,
                        payment_reference,
                        payment_type,
                        payment_method,
                        bank_code,
                        amount,
                        payment_status,
                        proof_url,
                        paid_at,
                        created_at,
                        updated_at
                    `,
                    [
                        payment_method,

                        payment_method ===
                            "TRANSFER"
                            ? bank_code
                            : null,

                        paymentReference,
                    ]
                );

            res.json({
                success: true,
                message:
                    "Pembayaran berhasil dikonfirmasi dan menunggu verifikasi",
                data: {
                    ...result
                        .rows[0],

                    amount: Number(
                        result.rows[0]
                            .amount
                    ),
                },
            });
        } catch (error) {
            console.error(
                "Confirm payment error:",
                error
            );

            res.status(500).json({
                success: false,
                message:
                    "Gagal mengkonfirmasi pembayaran",
            });
        }
    }
);
// ========================================
// CUSTOMER - CREATE REMAINING PAYMENT
// ========================================
router.post(
    "/:orderNumber/remaining",
    authMiddleware,
    async (req, res) => {
        const client =
            await pool.connect();

        try {
            await client.query(
                "BEGIN"
            );

            const {
                orderNumber,
            } = req.params;

            const userId =
                req.user.userId;

            // ==============================
            // GET BOOKING MILIK CUSTOMER
            // ==============================
            const bookingResult =
                await client.query(
                    `
                    SELECT
                        id,
                        order_number,
                        user_id,
                        grand_total,
                        payment_type,
                        rental_status
                    FROM bookings
                    WHERE order_number = $1
                    FOR UPDATE
                    `,
                    [
                        orderNumber,
                    ]
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
                        success:
                            false,

                        message:
                            "Booking tidak ditemukan",
                    });
            }

            const booking =
                bookingResult
                    .rows[0];

            // ==============================
            // PASTIKAN BOOKING MILIK USER
            // ==============================
            if (
                Number(
                    booking.user_id
                ) !==
                Number(userId)
            ) {
                await client.query(
                    "ROLLBACK"
                );

                return res
                    .status(403)
                    .json({
                        success:
                            false,

                        message:
                            "Anda tidak memiliki akses ke booking ini",
                    });
            }

            // ==============================
            // BOOKING HARUS TIPE DP
            // ==============================
            if (
                booking.payment_type !==
                "DP"
            ) {
                await client.query(
                    "ROLLBACK"
                );

                return res
                    .status(400)
                    .json({
                        success:
                            false,

                        message:
                            "Booking ini bukan pembayaran DP",
                    });
            }

            // ==============================
            // CEK DP SUDAH PAID
            // ==============================
            const dpResult =
                await client.query(
                    `
                    SELECT id
                    FROM payments
                    WHERE booking_id = $1
                      AND payment_type = 'DP'
                      AND payment_status = 'PAID'
                    LIMIT 1
                    `,
                    [
                        booking.id,
                    ]
                );

            if (
                dpResult.rows
                    .length === 0
            ) {
                await client.query(
                    "ROLLBACK"
                );

                return res
                    .status(400)
                    .json({
                        success:
                            false,

                        message:
                            "DP belum terverifikasi",
                    });
            }

            // ==============================
            // HITUNG TOTAL SUDAH PAID
            // ==============================
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
                    [
                        booking.id,
                    ]
                );

            const totalPaid =
                Number(
                    paidResult
                        .rows[0]
                        .total_paid
                );

            const grandTotal =
                Number(
                    booking
                        .grand_total
                );

            const remaining =
                grandTotal -
                totalPaid;

            // ==============================
            // SUDAH LUNAS
            // ==============================
            if (
                remaining <= 0
            ) {
                await client.query(
                    "ROLLBACK"
                );

                return res
                    .status(400)
                    .json({
                        success:
                            false,

                        message:
                            "Booking sudah lunas",
                    });
            }

            // ==============================
            // CEK TRANSAKSI REMAINING AKTIF
            // ==============================
            const existingResult =
                await client.query(
                    `
                    SELECT *
                    FROM payments
                    WHERE booking_id = $1
                      AND payment_type = 'REMAINING'
                      AND payment_status IN (
                          'PENDING',
                          'WAITING_VERIFICATION',
                          'PAID'
                      )
                    ORDER BY created_at DESC
                    LIMIT 1
                    `,
                    [
                        booking.id,
                    ]
                );

            // Kalau sudah pernah dibuat,
            // jangan buat payment dobel
            if (
                existingResult.rows
                    .length > 0
            ) {
                await client.query(
                    "COMMIT"
                );

                const existing =
                    existingResult
                        .rows[0];

                return res.json({
                    success: true,

                    message:
                        "Pembayaran pelunasan sudah tersedia",

                    data: {
                        ...existing,

                        amount:
                            Number(
                                existing
                                    .amount
                            ),
                    },
                });
            }

            // ==============================
            // CREATE REFERENCE
            // ==============================
            const paymentReference =
                `PAY-REM-${Date.now()}`;

            // ==============================
            // CREATE REMAINING PAYMENT
            // ==============================
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
                        'REMAINING',
                        $3,
                        'PENDING'
                    )
                    RETURNING *
                    `,
                    [
                        booking.id,
                        paymentReference,
                        remaining,
                    ]
                );

            await client.query(
                "COMMIT"
            );

            const payment =
                paymentResult
                    .rows[0];

            return res
                .status(201)
                .json({
                    success: true,

                    message:
                        "Pembayaran pelunasan berhasil dibuat",

                    data: {
                        ...payment,

                        amount:
                            Number(
                                payment
                                    .amount
                            ),
                    },
                });
        } catch (error) {
            await client.query(
                "ROLLBACK"
            );

            console.error(
                "Create customer remaining payment error:",
                error
            );

            return res
                .status(500)
                .json({
                    success:
                        false,

                    message:
                        "Gagal membuat pembayaran pelunasan",
                });
        } finally {
            client.release();
        }
    }
);
router.post("/admin/:orderNumber/remaining", async (req, res) => {
    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const { orderNumber } = req.params;
        const {
            payment_method,
            bank_code = null,
        } = req.body;

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

        const paidResult = await client.query(
            `
            SELECT COALESCE(SUM(amount), 0) AS total_paid
            FROM payments
            WHERE booking_id = $1
              AND payment_status = 'PAID'
            `,
            [booking.id]
        );

        const totalPaid = Number(
            paidResult.rows[0].total_paid
        );

        const grandTotal = Number(
            booking.grand_total
        );

        const remaining =
            grandTotal - totalPaid;

        if (remaining <= 0) {
            await client.query("ROLLBACK");

            return res.status(400).json({
                success: false,
                message: "Booking sudah lunas",
            });
        }

        const paymentReference =
            `PAY-REM-${Date.now()}`;

        const paymentResult =
            await client.query(
                `
                INSERT INTO payments (
                    booking_id,
                    payment_reference,
                    payment_type,
                    payment_method,
                    bank_code,
                    amount,
                    payment_status,
                    paid_at
                )
                VALUES (
                    $1,
                    $2,
                    'REMAINING',
                    $3,
                    $4,
                    $5,
                    'PAID',
                    NOW()
                )
                RETURNING *
                `,
                [
                    booking.id,
                    paymentReference,
                    payment_method,
                    bank_code,
                    remaining,
                ]
            );

        await client.query("COMMIT");

        res.json({
            success: true,
            message: "Pelunasan berhasil dicatat",
            data: {
                ...paymentResult.rows[0],
                amount: Number(
                    paymentResult.rows[0].amount
                ),
            },
        });

    } catch (error) {
        await client.query("ROLLBACK");

        console.error(
            "Remaining payment error:",
            error
        );

        res.status(500).json({
            success: false,
            message:
                "Gagal mencatat pelunasan",
        });

    } finally {
        client.release();
    }
});

module.exports = router;