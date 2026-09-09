const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const pool = require("../config/database");
const authMiddleware = require("../middleware/auth.middleware");

const router = express.Router();

const uploadRoot = path.join(
    __dirname,
    "../../uploads/verification"
);

const ktpDir = path.join(
    uploadRoot,
    "ktp"
);

const selfieDir = path.join(
    uploadRoot,
    "selfie"
);

fs.mkdirSync(ktpDir, {
    recursive: true,
});

fs.mkdirSync(selfieDir, {
    recursive: true,
});

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        if (file.fieldname === "ktp") {
            cb(null, ktpDir);
            return;
        }

        if (file.fieldname === "selfie") {
            cb(null, selfieDir);
            return;
        }

        cb(
            new Error(
                "Field upload tidak valid"
            )
        );
    },

    filename: (req, file, cb) => {
        const ext =
            path.extname(
                file.originalname
            ).toLowerCase();

        const uniqueName =
            `${req.user.userId}-${Date.now()}${ext}`;

        cb(null, uniqueName);
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
        !allowedTypes.includes(
            file.mimetype
        )
    ) {
        return cb(
            new Error(
                "File harus JPG, PNG, atau WEBP"
            )
        );
    }

    cb(null, true);
};

const upload = multer({
    storage,
    fileFilter,
    limits: {
        fileSize:
            5 * 1024 * 1024,
    },
});

router.post(
    "/submit",
    authMiddleware,

    upload.fields([
        {
            name: "ktp",
            maxCount: 1,
        },
        {
            name: "selfie",
            maxCount: 1,
        },
    ]),

    async (req, res) => {
        const client =
            await pool.connect();

        try {
            const {
                nik,
                full_name,
            } = req.body;

            const ktp =
                req.files?.ktp?.[0];

            const selfie =
                req.files?.selfie?.[0];

            if (
                !nik ||
                !full_name
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        "NIK dan nama lengkap wajib diisi",
                });
            }

            if (
                !/^\d{16}$/.test(nik)
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        "NIK harus 16 digit angka",
                });
            }

            if (!ktp || !selfie) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Foto KTP dan selfie wajib diupload",
                });
            }

            const ktpUrl =
                `/uploads/verification/ktp/${ktp.filename}`;

            const selfieUrl =
                `/uploads/verification/selfie/${selfie.filename}`;

            await client.query("BEGIN");

            const existing =
                await client.query(
                    `
                    SELECT id
                    FROM user_verifications
                    WHERE user_id = $1
                    LIMIT 1
                    `,
                    [
                        req.user.userId,
                    ]
                );

            let verification;

            if (
                existing.rows.length > 0
            ) {
                const result =
                    await client.query(
                        `
                        UPDATE user_verifications
                        SET
                            nik = $1,
                            full_name = $2,
                            ktp_image_url = $3,
                            selfie_image_url = $4,
                            verification_status = 'PENDING',
                            rejection_reason = NULL,
                            submitted_at = NOW(),
                            verified_at = NULL
                        WHERE user_id = $5
                        RETURNING *
                        `,
                        [
                            nik,
                            full_name.trim(),
                            ktpUrl,
                            selfieUrl,
                            req.user.userId,
                        ]
                    );

                verification =
                    result.rows[0];
            } else {
                const result =
                    await client.query(
                        `
                        INSERT INTO user_verifications (
                            user_id,
                            nik,
                            full_name,
                            ktp_image_url,
                            selfie_image_url,
                            verification_status
                        )
                        VALUES (
                            $1,
                            $2,
                            $3,
                            $4,
                            $5,
                            'PENDING'
                        )
                        RETURNING *
                        `,
                        [
                            req.user.userId,
                            nik,
                            full_name.trim(),
                            ktpUrl,
                            selfieUrl,
                        ]
                    );

                verification =
                    result.rows[0];
            }

            await client.query(
                `
                UPDATE users
                SET
                    verification_status = 'PENDING',
                    updated_at = NOW()
                WHERE id = $1
                `,
                [
                    req.user.userId,
                ]
            );

            await client.query(
                "COMMIT"
            );

            return res.json({
                success: true,
                message:
                    "Data verifikasi berhasil dikirim",
                data: {
                    verification,
                },
            });
        } catch (error) {
            await client.query(
                "ROLLBACK"
            );

            console.error(
                "Submit verification error:",
                error
            );

            return res.status(500).json({
                success: false,
                message:
                    "Gagal mengirim data verifikasi",
            });
        } finally {
            client.release();
        }
    }
);

module.exports = router;