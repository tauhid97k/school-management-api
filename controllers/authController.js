const prisma = require('../utils/prisma')
const bcrypt = require('bcrypt')
const jwt = require('jsonwebtoken')
const isEmpty = require('lodash/isEmpty')
const asyncHandler = require('express-async-handler')
const createError = require('../utils/errorHandler')
const {
  sendEmailVerifyCode,
  sendPasswordResetCode,
} = require('../utils/mailHandlers')
const registerValidator = require('../validators/registerValidator')
const loginValidator = require('../validators/loginValidator')
const {
  emailVerifyValidator,
  passwordResetValidator,
  resetCodeVerifyValidator,
  passwordUpdateValidator,
} = require('../validators/verificationValidators')
const assignRole = require('../utils/assignRole')

/*
  @route    POST: /register
  @access   public
  @desc     New user registration
*/
const register = asyncHandler(async (req, res, next) => {
  const data = await registerValidator.validate(req.body, { abortEarly: false })

  // Encrypt password
  data.password = await bcrypt.hash(data.password, 12)

  // Create new user
  await prisma.$transaction(
    async (tx) => {
      const admin = await tx.admins.create({ data })

      // Assign a role (Default admin for public registration)
      await assignRole(admin.id, 'admin', tx)

      // Send a verification code to email
      const verificationCode = Math.floor(10000000 + Math.random() * 90000000)
      await sendEmailVerifyCode(data.email, 'admin', verificationCode, tx)

      // Login the admin
      // Generate JWT Access Token
      const accessToken = jwt.sign(
        {
          user: {
            email: admin.email,
            role: 'admin',
          },
        },
        process.env.ACCESS_TOKEN_SECRET,
        { expiresIn: '1d' }
      )

      // Generate JWT Refresh Token
      const refreshToken = jwt.sign(
        {
          user: {
            email: admin.email,
            role: 'admin',
          },
        },
        process.env.REFRESH_TOKEN_SECRET,
        { expiresIn: '7d' }
      )

      // JWT expiry
      const jwtExpireTime = jwt.decode(refreshToken, { complete: true }).payload
        .exp

      // Save refresh token to database with device model (if available)
      const deviceBrand = isEmpty(req.device.device.brand)
        ? ''
        : req.device.device.brand
      const deviceModel = isEmpty(req.device.device.model)
        ? ''
        : req.device.device.model
      const deviceWithModel =
        deviceBrand && deviceModel ? `${deviceBrand} ${deviceModel}` : 'unknown'

      await tx.personal_tokens.create({
        data: {
          admin_id: admin.id,
          refresh_token: refreshToken,
          expires_at: jwtExpireTime,
          user_device: deviceWithModel,
        },
      })

      // Create secure cookie with refresh token
      res.cookie('express_jwt', refreshToken, {
        httpOnly: true, // Accessible only by server
        secure: false, // https
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      })

      res.status(201).json({
        message: 'Account created',
        accessToken,
      })
    },
    {
      timeout: 7000,
    }
  )
})

/*
  @route    GET: /resend-email
  @access   private
  @desc     Resend email (If not verified/received during registration)
*/
const resendEmail = asyncHandler(async (req, res, next) => {
  const user = req.user
  const verificationCode = Math.floor(10000000 + Math.random() * 90000000)

  await prisma.$transaction(async (tx) => {
    if (user.email_verified_at) {
      return res.json({ message: 'Your email is already verified' })
    }

    // Delete other verification tokens (if exist)
    await tx.admins.update({
      where: {
        email: user.email,
      },
      data: {
        verification_tokens: {
          deleteMany: {
            admin_id: user.id,
          },
        },
      },
    })

    await sendEmailVerifyCode(user.email, 'admin', verificationCode, tx)
  })

  res.json({
    message: 'A new verification code has been sent to your email',
  })
})

/*
  @route    GET: /verify-email
  @access   private
  @desc     Verify Email
*/
const verifyEmail = asyncHandler(async (req, res, next) => {
  const { token, code } = await emailVerifyValidator.validate(req.body, {
    abortEarly: false,
  })

  const user = req.user

  await prisma.$transaction(async (tx) => {
    const checkVerifyCode = await tx.verification_tokens.findFirst({
      where: {
        AND: [{ token }, { code }],
      },
    })

    if (!checkVerifyCode) {
      return res.json({ message: 'Invalid Code' })
    }

    if (user.role === 'admin') {
      await tx.admins.update({
        where: {
          email: user.email,
        },
        data: {
          email_verified_at: new Date(),
        },
      })
    }

    if (user.role === 'teacher') {
      await tx.teachers.update({
        where: {
          email: user.email,
        },
        data: {
          email_verified_at: new Date(),
        },
      })
    }

    if (user.role === 'student') {
      await tx.students.update({
        where: {
          email: user.email,
        },
        data: {
          email_verified_at: new Date(),
        },
      })
    }

    res.json({
      message: 'Verification successful',
    })
  })
})

/*
  @route    POST: /login
  @access   public
  @desc     User login
*/
const login = asyncHandler(async (req, res, next) => {
  // Check if any old cookie exist (delete it)
  const cookies = req.cookies
  if (cookies?.express_jwt) {
    res.clearCookie('express_jwt', {
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
    })
  }

  const { email, password, role } = await loginValidator.validate(req.body, {
    abortEarly: false,
  })

  await prisma.$transaction(async (tx) => {
    let user
    if (role === 'admin') {
      user = await tx.admins.findUnique({
        where: {
          email,
        },
      })
    }

    if (role === 'teacher') {
      user = await tx.teachers.findUnique({
        where: {
          email,
        },
      })
    }

    if (role === 'student') {
      user = await tx.students.findUnique({
        where: {
          email,
        },
      })
    }

    // Validate Password
    const isPasswordValid = await bcrypt.compare(password, user.password)

    // Check user
    if (email === user.email && isPasswordValid) {
      if (user.is_suspended)
        throw new createError(403, 'Your account is suspended')

      // Generate JWT Access Token
      const accessToken = jwt.sign(
        {
          user: {
            email: user.email,
            role,
          },
        },
        process.env.ACCESS_TOKEN_SECRET,
        { expiresIn: '1d' }
      )

      // Generate JWT Refresh Token
      const refreshToken = jwt.sign(
        {
          user: {
            email: user.email,
            role,
          },
        },
        process.env.REFRESH_TOKEN_SECRET,
        { expiresIn: '7d' }
      )

      // JWT expiry
      const jwtExpireTime = jwt.decode(refreshToken, { complete: true }).payload
        .exp

      // Save refresh token to database with device model (if available)
      const deviceBrand = isEmpty(req.device.device.brand)
        ? ''
        : req.device.device.brand
      const deviceModel = isEmpty(req.device.device.model)
        ? ''
        : req.device.device.model
      const deviceWithModel =
        deviceBrand && deviceModel ? `${deviceBrand} ${deviceModel}` : 'unknown'

      if (role === 'admin') {
        await tx.personal_tokens.create({
          data: {
            admin_id: user.id,
            refresh_token: refreshToken,
            expires_at: jwtExpireTime,
            user_device: deviceWithModel,
          },
        })
      }

      if (role === 'teacher') {
        await tx.personal_tokens.create({
          data: {
            teacher_id: user.id,
            refresh_token: refreshToken,
            expires_at: jwtExpireTime,
            user_device: deviceWithModel,
          },
        })
      }

      if (role === 'student') {
        await tx.personal_tokens.create({
          data: {
            student_id: user.id,
            refresh_token: refreshToken,
            expires_at: jwtExpireTime,
            user_device: deviceWithModel,
          },
        })
      }

      // Create secure cookie with refresh token
      res.cookie('express_jwt', refreshToken, {
        httpOnly: true, // Accessible only by server
        secure: false, // https
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      })

      res.json({
        accessToken,
      })
    } else {
      throw new createError(401, 'Invalid email or password')
    }
  })
})

/*
  @route    GET: /refresh
  @access   public
  @desc     Generate access token (because access token has expired)
*/
const refreshAuthToken = asyncHandler(async (req, res, next) => {
  const cookies = req.cookies
  if (!cookies?.express_jwt)
    return res.status(401).json({ message: 'Unauthorized' })

  const refreshToken = cookies.express_jwt

  // Check if tokens exist
  const tokens = await prisma.personal_tokens.findMany({
    where: {
      refresh_token: refreshToken,
    },
  })

  // Delete current cookie
  res.clearCookie('express_jwt', {
    httpOnly: true,
    secure: false,
    sameSite: 'lax',
  })

  // Possible reuse of refresh token detection
  if (!tokens.length) {
    jwt.verify(
      refreshToken,
      process.env.REFRESH_TOKEN_SECRET,
      asyncHandler(async (error, decoded) => {
        if (error) return res.status(403).json({ message: 'Forbidden' })

        // Check if user exist
        const email = decoded.user.email
        const role = decoded.user.role
        let possibleCompromisedUser

        if (role === 'admin') {
          possibleCompromisedUser = await prisma.admins.findUnique({
            where: {
              email,
            },
          })
        }

        if (role === 'teacher') {
          possibleCompromisedUser = await prisma.teachers.findUnique({
            where: {
              email,
            },
          })
        }

        if (role === 'student') {
          possibleCompromisedUser = await prisma.students.findUnique({
            where: {
              email,
            },
          })
        }

        // If user exist, delete all related tokens
        if (possibleCompromisedUser) {
          if (role === 'admin') {
            await prisma.personal_tokens.deleteMany({
              where: {
                admin_id: possibleCompromisedUser.id,
              },
            })
          }

          if (role === 'teacher') {
            await prisma.personal_tokens.deleteMany({
              where: {
                teacher_id: possibleCompromisedUser.id,
              },
            })
          }

          if (role === 'student') {
            await prisma.personal_tokens.deleteMany({
              where: {
                student_id: possibleCompromisedUser.id,
              },
            })
          }
        }
      })
    )

    // Don't let go further
    return res.status(403).json({ message: 'Forbidden' })
  }

  // If token exist, verify the token
  jwt.verify(
    refreshToken,
    process.env.REFRESH_TOKEN_SECRET,
    asyncHandler(async (error, decoded) => {
      if (error) return res.status(403).json({ message: 'Forbidden' })

      const email = decoded.user.email
      const role = decoded.user.role
      let user

      // Get current user
      if (role === 'admin') {
        user = await prisma.admins.findUnique({
          where: {
            email,
          },
        })
      }

      if (role === 'teacher') {
        user = await prisma.teachers.findUnique({
          where: {
            email,
          },
        })
      }

      if (role === 'student') {
        user = await prisma.students.findUnique({
          where: {
            email,
          },
        })
      }

      if (!user) return res.status(401).json({ message: 'Unauthorized' })

      // New JWT Access Token
      const newAccessToken = jwt.sign(
        {
          user: {
            email: user.email,
            role,
          },
        },
        process.env.ACCESS_TOKEN_SECRET,
        { expiresIn: '2m' }
      )

      // New JWT Refresh Token
      const newRefreshToken = jwt.sign(
        {
          user: {
            email: user.email,
            role,
          },
        },
        process.env.REFRESH_TOKEN_SECRET,
        { expiresIn: '7d' }
      )

      // JWT expiry
      const jwtExpireTime = jwt.decode(newRefreshToken, { complete: true })
        .payload.exp

      // Save and update refresh token in database
      await prisma.personal_tokens.updateMany({
        where: {
          refresh_token: refreshToken,
        },
        data: {
          refresh_token: newRefreshToken,
          expires_at: jwtExpireTime,
        },
      })

      // Create new secure cookie with refresh token
      res.cookie('express_jwt', newRefreshToken, {
        httpOnly: true, // Accessible only by server
        secure: false, // https
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      })

      res.json({ accessToken: newAccessToken })
    })
  )
})

/*
  @route    GET: /user
  @access   private
  @desc     Auth user
*/
const authUser = asyncHandler(async (req, res, next) => {
  res.json(req.user)
})

/*
  @route    POST: /logout
  @access   private
  @desc     Logout auth user
*/
const logout = asyncHandler(async (req, res, next) => {
  await prisma.$transaction(async (tx) => {
    const cookies = req.cookies
    if (!cookies?.express_jwt)
      return res.status(401).json({ message: 'Unauthorized' })

    const refreshToken = cookies.express_jwt

    // Delete refresh tokens from database
    await tx.personal_tokens.deleteMany({
      where: {
        refresh_token: refreshToken,
      },
    })

    // Clear cookie
    res.clearCookie('express_jwt', {
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
    })

    res.json({
      message: 'You are now logged out',
    })
  })
})

/*
  @route    POST: /logout-all
  @access   private
  @desc     Logout user's all devices
*/
const logoutAll = asyncHandler(async (req, res, next) => {
  await prisma.$transaction(async (tx) => {
    const cookies = req.cookies
    if (!cookies?.express_jwt)
      return res.status(401).json({ message: 'Unauthorized' })

    // Get the user
    const email = req.user.email
    const role = req.user.role
    let user

    if (role === 'admin') {
      user = await tx.admins.findUnique({
        where: {
          email,
        },
      })
    }

    if (role === 'teacher') {
      user = await tx.teachers.findUnique({
        where: {
          email,
        },
      })
    }

    if (role === 'student') {
      user = await tx.students.findUnique({
        where: {
          email,
        },
      })
    }

    // Delete refresh tokens from database
    if (role === 'admin') {
      await tx.personal_tokens.deleteMany({
        where: {
          admin_id: user.id,
        },
      })
    }

    if (role === 'teacher') {
      await tx.personal_tokens.deleteMany({
        where: {
          teacher_id: user.id,
        },
      })
    }

    if (role === 'student') {
      await tx.personal_tokens.deleteMany({
        where: {
          student_id: user.id,
        },
      })
    }

    // Clear cookie
    res.clearCookie('express_jwt', {
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
    })

    res.json({
      message: 'All devices are logged out',
    })
  })
})

/*
  @route    POST: /reset-password
  @access   public
  @desc     Request for resetting password
*/
const resetPassword = asyncHandler(async (req, res, next) => {
  const { email, role } = await passwordResetValidator.validate(req.body, {
    abortEarly: false,
  })

  // Send a password reset code to email
  const resetCode = Math.floor(10000000 + Math.random() * 90000000)
  await sendPasswordResetCode(email, role, resetCode)

  res.json({
    message: 'A verification code has been sent to your email',
  })
})

/*
  @route    POST: /verify-reset-code
  @access   public
  @desc     Verify password reset code
*/
const verifyResetCode = asyncHandler(async (req, res, next) => {
  const { token, code } = await resetCodeVerifyValidator.validate(req.body, {
    abortEarly: false,
  })

  const checkVerifyCode = await prisma.verification_tokens.findFirst({
    where: {
      AND: [{ token }, { code }],
    },
  })

  if (!checkVerifyCode) {
    return res.json({ message: 'Invalid Code' })
  }

  // Get user id based on role
  let userId
  let role
  if (checkVerifyCode.admin_id) {
    userId = checkVerifyCode.admin_id
    role = 'admin'
  }

  if (checkVerifyCode.teacher_id) {
    userId = checkVerifyCode.teacher_id
    role = 'teacher'
  }

  if (checkVerifyCode.student_id) {
    userId = checkVerifyCode.student_id
    role = 'student'
  }

  // Generate A Token (With user id)
  const passwordResetToken = jwt.sign(
    {
      user: {
        id: userId,
        role,
      },
    },
    process.env.RESET_TOKEN_SECRET,
    { expiresIn: '4m' }
  )

  res.json({
    message: 'Verification successful',
    token: passwordResetToken,
  })
})

/*
  @route    POST: /update-password
  @access   public
  @desc     Update password
*/
const updatePassword = asyncHandler(async (req, res, next) => {
  const data = await passwordUpdateValidator.validate(req.body, {
    abortEarly: false,
  })

  // Check Reset Token Header
  const resetTokenHeader =
    req.headers.authorization || req.headers.Authorization

  if (!resetTokenHeader?.startsWith('Bearer ')) {
    return res.status(403).json({ message: 'Forbidden' })
  }

  const token = resetTokenHeader.split(' ')[1]

  jwt.verify(token, process.env.RESET_TOKEN_SECRET, async (error, decoded) => {
    if (error) return res.status(403).json({ message: 'Forbidden' })

    await prisma.$transaction(async (tx) => {
      const role = decoded.user.role
      const userId = decoded.user.id
      let user

      if (role === 'admin') {
        user = await tx.admins.findUnique({
          where: {
            id: userId,
          },
        })
      }

      if (role === 'teacher') {
        user = await tx.teachers.findUnique({
          where: {
            id: userId,
          },
        })
      }

      if (role === 'student') {
        user = await tx.students.findUnique({
          where: {
            id: userId,
          },
        })
      }

      if (!user) {
        return res.status(404).json({ message: 'User not found' })
      }

      // Delete user's previous login tokens (based on role)
      if (role === 'admin') {
        await tx.personal_tokens.deleteMany({
          where: {
            admin_id: user.id,
          },
        })
      }

      if (role === 'teacher') {
        await tx.personal_tokens.deleteMany({
          where: {
            teacher_id: user.id,
          },
        })
      }

      if (role === 'student') {
        await tx.personal_tokens.deleteMany({
          where: {
            student_id: user.id,
          },
        })
      }

      // Encrypt password
      data.password = await bcrypt.hash(data.password, 12)

      // Update user password (Based on role)
      if (role === 'admin') {
        await tx.admins.update({
          where: {
            email: user.email,
          },
          data: {
            password: data.password,
            verification_tokens: {
              deleteMany: {
                admin_id: user.id,
              },
            },
          },
        })
      }

      if (role === 'teacher') {
        await tx.teachers.update({
          where: {
            email: user.email,
          },
          data: {
            password: data.password,
            verification_tokens: {
              deleteMany: {
                teacher_id: user.id,
              },
            },
          },
        })
      }

      if (role === 'student') {
        await tx.students.update({
          where: {
            email: user.email,
          },
          data: {
            password: data.password,
            verification_tokens: {
              deleteMany: {
                student_id: user.id,
              },
            },
          },
        })
      }
    })

    res.json({
      message: 'Password has been updated',
    })
  })
})

module.exports = {
  register,
  resendEmail,
  verifyEmail,
  login,
  refreshAuthToken,
  authUser,
  logout,
  logoutAll,
  resetPassword,
  verifyResetCode,
  updatePassword,
}
